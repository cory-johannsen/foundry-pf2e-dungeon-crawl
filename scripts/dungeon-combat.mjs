/**
 * Wires a combat room's spawned encounter into a real PF2e Combat — see
 * ITEM-6 in docs/backlog.md for the full design and the live-research
 * findings behind the specific API calls below (rollAll/rollInitiative and
 * endCombat both hang on an interactive dialog when called from a script;
 * `rollInitiative(ids, {skipDialog:true})` and `combat.delete()` are the
 * confirmed-working equivalents).
 *
 * Deliberately takes no dependency on dungeon-scene.mjs or ui/dungeon-app.mjs
 * — both of those need things from here (dungeon-scene.mjs starts combat on
 * room entry; dungeon-app.mjs's manual GM buttons resolve it), so this file
 * only ever hands back plain data (`{outcome, dungeonSlot, scene}`) from its
 * auto-resolution checks rather than calling back into either of them.
 * module.mjs — the composition root that already imports from every one of
 * these files — is what stitches "combat resolved" to "advance the room."
 */
import { makeFoundryApi, SIZE_ORDER } from "./foundry-api.mjs";
import { getRunState } from "./dungeon-runner.mjs";
import { totalCombatXp } from "./combat-rewards.mjs";
import {
  initAgentTurnState,
  buildCandidateList,
  applyCandidateToTurnState,
  buildDecisionContext,
  parseConditionsByOutcome,
  hasSpellUsesRemaining,
  hasSpellSlotRemaining,
  parseBreathWeaponEffect,
  parseMultiStrikeBundle,
  parseChainHopDistance,
  parseAreaSpellTierOverrides,
  parseActionGlyphTiers,
  parseTargetCountFormula,
  parseAutoHitAreaTiers,
  parseSpellEffectUuid,
  parseReactiveStrikeWeaponRestriction,
  AGENT_MELEE_REACH_SQUARES,
  DEMORALIZE_RANGE_SQUARES,
  buildManeuverVocabulary,
  MANEUVER_DEFS,
  maneuverHasAttackTrait,
  buildFeatVocabulary,
  buildNpcAbilityVocabulary,
  buildNpcMoveVocabulary,
  buildNpcStrikeVocabulary,
  buildNpcSelfVocabulary,
} from "./agent-candidates.mjs";
import { parseSaveAbility, describeNpcAbility, describeNpcPenalty, npcAbilityExcludesTarget } from "./npc-ability-parse.mjs";
import { parseMovementAbility, npcMoveBudget, describeNpcMove } from "./npc-move-parse.mjs";
import { parseStrikePlusAbility, describeStrikePlus } from "./npc-strike-shapes.mjs";
import { parseSelfAbility, describeNpcSelfAbility } from "./npc-self-parse.mjs";
import {
  findPath,
  blockedEdgesFromWalls,
  hasLineOfSight as sightLineClear,
  wallBlocksMovement,
} from "./pathfinding.mjs";
import { footprint, overlaps } from "./placement.mjs";
import { readPacingSetting, walkTokenThroughSteps } from "./token-walk.mjs";
import { LOOTABLE_ITEM_TYPES } from "./treasure.mjs";
import { coverBlocksLineOfFire, COVER_EFFECT_DATA } from "./cover-items.mjs";
import {
  playStrikeSound,
  playSpellSaveSound,
  playAttackSpellSound,
  playCreatureDeathSound,
} from "./dungeon-sound.mjs";
import {
  postStrikeRiderReminder,
  postCriticalSpecializationReminder,
  resolveGrabRider,
  resolveKnockdownRider,
  resolveAthleticsRider,
  PUSH_RIDER_SLUGS,
  recordGrab,
  clearGrabsInvolving,
  currentGrabTarget,
  releaseGrab,
  grabRecordOf,
  GRAB_CONDITION_SLUGS,
  handleGrabConditionRemoved,
} from "./dungeon-strike-riders.mjs";
import {
  drawAndApplyCriticalCard,
  hitDeckCategory,
  fumbleDeckCategory,
  naturalD20,
  criticalCardKindFor,
} from "./dungeon-critical-deck.mjs";
import { fetchCombatDecision, fetchCombatCandidates } from "./agent-service-client.mjs";
import { withDialogsSuppressed } from "./trap-combat.mjs";
import { eligibilityModifiers, ridersFor, maneuverMapPenalty } from "./maneuver-feat-modifiers.mjs";
import { SELF_EFFECT_DENYLIST } from "./self-effect-denylist.mjs";
import { describeAgentAction, renderAgentTurnCardHtml } from "./agent-action-display.mjs";
import { summarizeEffect, effectDurationLabel, effectRelevanceTier } from "./self-effect-summary.mjs";
import {
  classifyTargetEffect,
  resolveTargetedSelfEffectConfig,
  summarizeMarkEffect,
  bindTokenMarkEffect,
  selectRollOptionSuboption,
  markedTokenUuids,
  findActiveMarkEffects,
  markAnnotation,
} from "./targeted-feat-actions.mjs";
import { parseFeatRequirements } from "./marked-target-requirements.mjs";
import { parseTargetedFeat, summarizeTargetedFeat } from "./feat-action-shapes.mjs";
import {
  ANTAGONIZE_FEAT_SLUG,
  readAntagonizeMap,
  frightenedFloorFor,
  sensesAntagonizer,
  evaluateAntagonizeEntry,
  isHostileCheckContext,
  hostileTargetIdsOf,
} from "./antagonize.mjs";
import {
  REACTION_DECISION_TIMEOUT_MS,
  reactionItemsFor,
  moveTriggerIndex,
  decideReaction,
  isHitOutcome,
  defensiveReactionMode,
  isGmLessRunState,
  reactionGmNoteHtml,
  escapeReactionHtml,
  reactionDefById,
  degreeOfSuccess,
} from "./npc-reactions.mjs";
import {
  DETECTION,
  applySeekOutcome,
  avoidingNoticeActorIds,
  canTargetState,
  hostileAwareness,
  initialDetection,
  stateFor,
  afterAttack,
  uniformCondition,
} from "./stealth-detection.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
// #361 revert of #141's own fix -- see dungeon-follow.mjs's own matching
// comment for the full story: {animation:{duration:0}} correctly stopped
// the interrupted-animation drift #141 diagnosed, but live-confirmed it
// also reliably triggers a genuine Foundry v14 core bug in its own
// #preUpdateMovement, aborting the calling function before any move could
// complete -- strictly worse than the drift it fixed. Reverted pending a
// fix that doesn't trigger the Foundry-core bug (see #361).

/** Ids of the actual party characters — this module's own definition of
 * "a real party member," used instead of Foundry's `hasPlayerOwner` wherever
 * a combatant needs to be told apart from an automated one. A solo-GM world
 * with no separate player-role users (confirmed live on the real deployed
 * world: one `Gamemaster`-role user owns every party actor directly) makes
 * `hasPlayerOwner` false for actual party characters too, since that getter
 * only counts non-GM users — this membership check doesn't depend on how
 * the world's users/ownership happen to be set up. */
function partyActorIds() {
  return new Set((game.actors?.party?.members ?? []).map((m) => m.id));
}

/** Whether a combatant with this actor id should default to
 * agent-controlled: every non-party actor always does (unchanged NPC
 * behavior); a party actor only does when this run flagged it AI-controlled
 * at start (#20 — its owning player isn't logged in). */
export function isAgentEligible(actorId, partyIds, aiControlledIds) {
  return !partyIds.has(actorId) || aiControlledIds.has(actorId);
}

/** Whether autoPlayCombatantTurnIfDue's turn-due combatant is excluded from
 * auto-play entirely: true for a human party member or a manually-added,
 * player-summoned ally (neither ever gets the agentControlled flag); false
 * for a run's AI-controlled party actor or a real NPC (both do). */
export function isExcludedFromAutoPlay(combatant, partyIds) {
  return (
    !combatant.getFlag(MODULE_ID, "agentControlled") &&
    (partyIds.has(combatant.actor?.id) || combatant.actor?.hasPlayerOwner)
  );
}

/** Every token on `scene` carrying `flagKey === flagValue`, plus every
 * current party token — excluding cover items (#96/#146) and trap hazards
 * (#135), neither of which ever takes a turn. Cover-item tokens carry the
 * exact same `dungeonSlot`/`encounterId` flag monster tokens do (so
 * `resolveCombat`'s own cleanup can find and delete them alongside an
 * encounter's monsters), which without this exclusion made them match here
 * too: an inert, action-less hazard Actor got a real Combatant, defaulting
 * to `agentControlled: true` and showing up in initiative — see
 * `coverItemTokensForCombat`'s docblock below, which already documented
 * "cover items are never Combatants" as the intended behavior this flag
 * collision was silently violating. A trap hazard's own `dungeonSlot` flag
 * (`dungeon-scene.mjs`'s `populateSlotTrap`) is never actually reached by
 * this filter in practice — a `trap` room never starts a Combat
 * at all — but excluding it here anyway costs nothing and closes off the
 * exact same class of bug before it can ever recur for a hazard actor that,
 * like a cover item, should never take a turn either. */
function combatantTokens(scene, flagKey, flagValue) {
  const monsterTokens = scene.tokens.filter(
    (t) =>
      t.getFlag(MODULE_ID, flagKey) === flagValue &&
      !t.getFlag(MODULE_ID, "coverItem") &&
      !t.getFlag(MODULE_ID, "trapHazard"),
  );
  const partyIds = partyActorIds();
  const partyTokens = scene.tokens.filter((t) => partyIds.has(t.actor?.id));
  return [...monsterTokens, ...partyTokens];
}

/**
 * Every non-party combatant defaults to agent-controlled
 * (flags["pf2e-dungeon-crawl"].agentControlled) the instant it's added to a Combat — a GM can disable it
 * per-combatant via the Combat Tracker's own context menu (module.mjs's
 * getCombatTrackerEntryContext hook). Party combatants never get the flag,
 * matching the partyActorIds() split ITEM-8's own reopening already uses.
 */
async function startCombat(scene, flagKey, flagValue) {
  const tokens = combatantTokens(scene, flagKey, flagValue);
  if (!tokens.length) return null;
  const combat = await Combat.create({ scene: scene.id });
  await combat.setFlag(MODULE_ID, flagKey, flagValue);
  const partyIds = partyActorIds();
  const aiControlledIds = new Set(
    getRunState(scene.id)?.aiControlledActorIds ?? [],
  );
  const combatants = await combat.createEmbeddedDocuments(
    "Combatant",
    tokens.map((t) => ({
      tokenId: t.id,
      sceneId: scene.id,
      ...(isAgentEligible(t.actor?.id, partyIds, aiControlledIds)
        ? { flags: { [MODULE_ID]: { agentControlled: true } } }
        : {}),
    })),
  );
  await rollStealthInitiativeAndDetect(combat, combatants, { partyIds });
  await combat.startCombat();
  unpauseIfGmLessRun(scene.id);
  return combat;
}

/** #616: display conditions this module applies to a sneaker. */
const DISPLAY_CONDITIONS = new Set([DETECTION.UNNOTICED, DETECTION.UNDETECTED]);

const stealthDefaults = {
  rollStealth: (actor) =>
    withDialogsSuppressed(() => actor.skills.stealth.roll({ createMessage: true })),
  hasCondition: (actor, slug) =>
    Boolean(actor.hasCondition?.(slug) ?? actor.conditions?.bySlug?.(slug)?.length),
  // #616: Statistic#roll resolves to the CheckRoll, which carries
  // degreeOfSuccess (0 crit fail .. 3 crit success). Falling back to the last
  // chat message's context outcome is racy under concurrent rolls, so it is
  // only used when the roll result itself is unavailable.
  rollPerception: (actor, dc) =>
    withDialogsSuppressed(async () => {
      const roll = await actor.perception.roll({ dc: { value: dc }, createMessage: true });
      const byDegree = ["criticalFailure", "failure", "success", "criticalSuccess"];
      if (byDegree[roll?.degreeOfSuccess]) return byDegree[roll.degreeOfSuccess];
      // Fallback only when the roll carried no degree AND the newest chat
      // message is this actor's own roll (racy otherwise).
      const last = game.messages?.contents?.at(-1);
      const speakerActor = last?.actor?.id ?? last?.speaker?.actor;
      return speakerActor === actor.id
        ? (last?.flags?.pf2e?.context?.outcome ?? "failure")
        : "failure";
    }),
  setCondition: async (actor, slug, active) => {
    if (active) await actor.increaseCondition(slug);
    else await actor.decreaseCondition(slug, { forceRemove: true });
  },
  chat: async (key, data) => {
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    const safe = Object.fromEntries(
      Object.entries(data ?? {}).map(([k, v]) => [k, esc(v)]),
    );
    await ChatMessage.create({ content: game.i18n.format(key, safe) });
  },
};

/**
 * #616: Rolls initiative for a freshly created combat. Party members who are
 * Avoiding Notice roll Stealth (PF2e "Initiative with Stealth"); everyone else
 * goes through `combat.rollInitiative` exactly as before. With no sneaker this
 * is a single unchanged `rollInitiative(allIds, {skipDialog:true})` call and
 * nothing else. Otherwise it stores the detection matrix
 * (`flags[MODULE_ID].detection`) and, for display, applies the `unnoticed` /
 * `undetected` condition when uniform across hostiles (recorded in
 * `appliedConditions` so `clearDetection` removes only what we added).
 */
export async function rollStealthInitiativeAndDetect(combat, combatants, deps = {}) {
  const d = { ...stealthDefaults, ...deps };
  const partyIds = d.partyIds ?? partyActorIds();
  const allIds = combatants.map((c) => c.id);

  const partyCombatants = combatants.filter((c) => partyIds.has(c.actor?.id));
  const sneakingActorIds = new Set(
    avoidingNoticeActorIds(
      partyCombatants.map((c) => ({
        id: c.actor.id,
        exploration: c.actor.system?.exploration ?? [],
        items: Array.from(c.actor.items ?? []).map((i) => ({ id: i.id, slug: i.slug })),
      })),
    ),
  );
  const sneakers = partyCombatants.filter(
    (c) => sneakingActorIds.has(c.actor.id) && c.actor.skills?.stealth,
  );
  if (!sneakers.length) {
    await combat.rollInitiative(allIds, { skipDialog: true });
    return;
  }

  const sneakerIds = new Set(sneakers.map((c) => c.id));
  const others = allIds.filter((id) => !sneakerIds.has(id));
  if (others.length) await combat.rollInitiative(others, { skipDialog: true });

  const rolled = [];
  for (const c of sneakers) {
    const roll = await d.rollStealth(c.actor);
    rolled.push({ combatant: c, result: Number(roll?.total ?? 0) });
  }
  await combat.setMultipleInitiatives(
    rolled.map((r) => ({ id: r.combatant.id, value: r.result, statistic: "stealth" })),
  );

  // Observers are the sneakers' opponents by token disposition (the same rule
  // `combatantOpponents` uses), not "everyone outside the party": a friendly
  // encounter Friend or neutral NPC never notices/alarms.
  const sneakerSides = new Set(sneakers.map((c) => c.token?.disposition));
  const hostiles = combatants.filter(
    (c) =>
      !sneakerIds.has(c.id) &&
      !partyIds.has(c.actor?.id) &&
      [...sneakerSides].some((side) => c.token?.disposition !== side),
  );
  const hasObservedNonSneaker = partyCombatants.some(
    (c) => !sneakerIds.has(c.id) && !c.isDefeated,
  );
  const matrix = initialDetection({
    hasObservedNonSneaker,
    sneakers: rolled.map((r) => ({ id: r.combatant.id, result: r.result })),
    hostiles: hostiles.map((h) => ({
      id: h.id,
      // A hostile with no readable Perception DC is treated as noticing
      // (safe: it can then fight instead of stalling the combat unaware).
      dc: h.actor?.perception?.dc?.value ?? Infinity,
    })),
  });
  await combat.setFlag(MODULE_ID, "detection", matrix);

  const applied = {};
  for (const r of rolled) {
    const slug = uniformCondition(matrix, r.combatant.id);
    if (!DISPLAY_CONDITIONS.has(slug)) continue;
    if (d.hasCondition(r.combatant.actor, slug)) continue;
    await d.setCondition(r.combatant.actor, slug, true);
    applied[r.combatant.id] = { actorId: r.combatant.actor.id, slug };
  }
  await combat.setFlag(MODULE_ID, "appliedConditions", applied);

  for (const r of rolled) {
    const row = matrix[r.combatant.id] ?? {};
    const observers = hostiles
      .filter((h) => row[h.id] === DETECTION.OBSERVED)
      .map((h) => h.name);
    if (observers.length) {
      await d.chat("PF2EDC.Dungeon.Combat.StealthNoticedChat", {
        name: r.combatant.name,
        result: r.result,
        observers: observers.join(", "),
      });
    } else if (hostiles.every((h) => row[h.id] === DETECTION.UNNOTICED)) {
      await d.chat("PF2EDC.Dungeon.Combat.StealthUnnoticedChat", {
        name: r.combatant.name,
        result: r.result,
      });
    } else {
      // The alarm rule (another party member was spotted) turned this
      // sneaker's unnoticed pairs into undetected: the foes know someone is
      // about, they just can't place this character.
      await d.chat("PF2EDC.Dungeon.Combat.StealthUndetectedChat", {
        name: r.combatant.name,
        result: r.result,
      });
    }
  }
}

/**
 * #616: `deleteCombat` cleanup. Removes only the display conditions this
 * module recorded in `appliedConditions` (never one the actor already had)
 * and clears the detection flags.
 */
export async function clearDetection(combat, deps = {}) {
  const d = { ...stealthDefaults, ...deps };
  const applied = combat.getFlag?.(MODULE_ID, "appliedConditions");
  if (applied) {
    for (const [combatantId, rec] of Object.entries(applied)) {
      const actor =
        combat.combatants?.get?.(combatantId)?.actor ?? game.actors?.get?.(rec.actorId);
      if (!actor) continue;
      await d.setCondition(actor, rec.slug, false);
    }
  }
  // No unsetFlag: this runs from `deleteCombat`, when the document is already
  // gone (the update would be rejected) and its flags go with it.
}

/**
 * #616: what a hostile knows about the party under the stealth matrix, or
 * `null` when there is no matrix (nothing to do: today's behavior). Downed
 * and defeated opponents are ignored (they are not valid targets anyway).
 */
function stealthAwarenessFor(combat, combatant) {
  const matrix = combat.getFlag?.(MODULE_ID, "detection");
  if (!matrix) return null;
  const ids = combatantOpponents(combat, combatant)
    .filter((c) => !isDownedCharacter(c))
    .map((c) => c.id);
  return hostileAwareness(matrix, combatant.id, ids);
}

/** #616: true when every sneaker is unnoticed by this hostile (it takes no offensive action). */
function isUnawareHostile(combat, combatant) {
  return Boolean(stealthAwarenessFor(combat, combatant)?.unaware);
}

/** #616: ids of sneakers this hostile may Seek: only when it has no observed target. */
function seekableSneakerIds(combat, combatant) {
  const awareness = stealthAwarenessFor(combat, combatant);
  if (!awareness || awareness.targetable.length) return [];
  return awareness.seekable;
}

/** #616: an unaware hostile ends its turn at once (no agent call, no timeout wait). */
async function endUnawareTurn(combat, combatant) {
  if (game.combats.has(combat.id) && combat.combatant?.id === combatant.id) {
    await combat.nextTurn();
  }
}

/**
 * #616: re-derive one sneaker's display condition from the current matrix.
 * Removes a condition this module applied if it no longer matches, applies the
 * new uniform one when the actor lacks it (recorded in `appliedConditions`),
 * and never touches a condition the actor already had from elsewhere.
 */
export async function refreshDisplayCondition(combat, sneakerCombatant, matrix, deps = {}) {
  const d = { ...stealthDefaults, ...deps };
  const actor = sneakerCombatant.actor;
  if (!actor) return;
  const applied = { ...(combat.getFlag?.(MODULE_ID, "appliedConditions") ?? {}) };
  const desired = uniformCondition(matrix, sneakerCombatant.id);
  const wanted = DISPLAY_CONDITIONS.has(desired) ? desired : null;
  const ours = applied[sneakerCombatant.id];
  if (ours && ours.slug === wanted) return;
  let changed = false;
  if (ours) {
    await d.setCondition(actor, ours.slug, false);
    delete applied[sneakerCombatant.id];
    changed = true;
  }
  if (wanted && !d.hasCondition(actor, wanted)) {
    await d.setCondition(actor, wanted, true);
    applied[sneakerCombatant.id] = { actorId: actor.id, slug: wanted };
    changed = true;
  }
  if (changed) await combat.setFlag(MODULE_ID, "appliedConditions", applied);
}

/**
 * #616: one Seek action by `hostile`: Perception vs each seekable sneaker's
 * Stealth DC (RAW outcomes via applySeekOutcome). Only that (sneaker, hostile)
 * pair changes. Refreshes display conditions and posts a chat line per change.
 * Returns [{ sneakerId, dc, outcome, from, to }].
 */
export async function performSeek(combat, hostile, deps = {}) {
  const d = { ...stealthDefaults, ...deps };
  const results = [];
  const seekIds = seekableSneakerIds(combat, hostile);
  if (!seekIds.length) return results;
  let matrix = combat.getFlag?.(MODULE_ID, "detection") ?? {};
  for (const sneakerId of seekIds) {
    const sneaker = combat.combatants.find((c) => c.id === sneakerId);
    const dc = sneaker?.actor?.skills?.stealth?.dc?.value;
    if (dc === undefined || dc === null) continue;
    const outcome = await d.rollPerception(hostile.actor, dc);
    const from = stateFor(matrix, sneakerId, hostile.id);
    const to = applySeekOutcome(from, outcome);
    results.push({ sneakerId, dc, outcome, from, to });
    if (to === from) continue;
    matrix = { ...matrix, [sneakerId]: { ...matrix[sneakerId], [hostile.id]: to } };
    await combat.setFlag(MODULE_ID, "detection", matrix);
    await refreshDisplayCondition(combat, sneaker, matrix, d);
    await d.chat("PF2EDC.Dungeon.Combat.SeekChat", {
      hostile: hostile.name,
      name: sneaker.name,
      state: to,
    });
  }
  return results;
}

const STEALTH_BREAK_TYPES = new Set(["attack-roll", "spell-attack-roll"]);

/** #616: a spell card (no attack roll) with a hostile effect: it has a save/
 * defense or deals damage, and is not a healing spell. Needs the cast item on
 * the message; without enough data it is NOT hostile (never breaks stealth). */
function isHostileSpellCard(message) {
  if (message?.flags?.pf2e?.origin?.type !== "spell") return false;
  const spell = message.item;
  if (!spell) return false;
  const traits = spell.traits ?? spell.system?.traits?.value;
  const hasTrait = (t) => (traits?.has ? traits.has(t) : Array.isArray(traits) && traits.includes(t));
  if (hasTrait("healing")) return false;
  const hasSave = Boolean(spell.system?.defense?.save?.statistic);
  const kinds = spell.damageKinds;
  const hasDamage = kinds?.has
    ? kinds.has("damage")
    : Object.keys(spell.system?.damage ?? {}).length > 0;
  return hasSave || hasDamage;
}

/**
 * #616: a sneaker's own attack roll (Strike or spell attack) reveals its
 * position: its unnoticed/undetected pairs become hidden (`afterAttack`);
 * observed pairs and other sneakers are untouched, and a hostile Seek can
 * later upgrade hidden again. Acts only on the active GM client, only for a
 * sneaker (a key of the detection matrix) in a module combat; a hostile's or
 * non-sneaker's attack, a non-attack message, or no active combat is a no-op
 * with no matrix write. Posts a chat line only when something changed.
 */
export async function handleStealthBreakMessage(message, deps = {}) {
  const d = { ...stealthDefaults, ...deps };
  const isGm = d.isActiveGm ?? (game.users?.activeGM?.isSelf ?? game.user?.isGM);
  if (!isGm) return;
  if (
    !STEALTH_BREAK_TYPES.has(message?.flags?.pf2e?.context?.type) &&
    !isHostileSpellCard(message)
  )
    return;
  const actorId = message.actor?.id ?? message.speaker?.actor;
  if (!actorId) return;
  const combats = d.combats ?? game.combats?.contents ?? [];
  for (const combat of combats) {
    if (!isModuleCombat(combat)) continue;
    const matrix = combat.getFlag?.(MODULE_ID, "detection");
    if (!matrix) continue;
    const sneaker = combat.combatants.find(
      (c) => c.actor?.id === actorId && Object.hasOwn(matrix, c.id),
    );
    if (!sneaker) continue;
    const next = afterAttack(matrix, sneaker.id);
    if (JSON.stringify(next) === JSON.stringify(matrix)) return;
    await combat.setFlag(MODULE_ID, "detection", next);
    await refreshDisplayCondition(combat, sneaker, next, d);
    await d.chat("PF2EDC.Dungeon.Combat.StealthRevealedChat", { name: sneaker.name });
    return;
  }
}

/** Flips a single combatant's agentControlled flag — the GM's per-combatant
 * override (module.mjs's Combat Tracker context-menu entry). A no-op guard
 * against toggling a real party member on by mistake, since one should
 * never have the flag in the first place. */
export async function toggleAgentControlled(combatant) {
  const aiControlledIds = new Set(
    getRunState(combatant.parent?.scene?.id)?.aiControlledActorIds ?? [],
  );
  if (!isAgentEligible(combatant.actor?.id, partyActorIds(), aiControlledIds))
    return;
  const current = combatant.getFlag(MODULE_ID, "agentControlled") ?? false;
  await combatant.setFlag(MODULE_ID, "agentControlled", !current);
}

// #93 pre-flight fix (Step 3d): renamed from startCombatForSlot/
// getCombatForSlot — purely a name change, both are already generic
// (scene, value) pass-throughs that never do arithmetic on the value, so
// this is safe now that the value is a room id string instead of an
// integer physicalSlot. The `dungeonSlot` flag NAME is unchanged (see
// dungeon-scene.mjs's buildPopulateAndUnlockGraphNode).
export const startCombatForRoom = (scene, slot) =>
  startCombat(scene, "dungeonSlot", slot);
export const startCombatForEncounterId = (scene, encounterId) =>
  startCombat(scene, "encounterId", encounterId);

export function getCombatForRoom(scene, slot) {
  return (
    game.combats.find(
      (c) =>
        c.scene?.id === scene.id &&
        c.getFlag(MODULE_ID, "dungeonSlot") === slot,
    ) ?? null
  );
}

function isModuleCombat(c) {
  return (
    c.getFlag(MODULE_ID, "dungeonSlot") != null ||
    c.getFlag(MODULE_ID, "encounterId") != null
  );
}

/**
 * A human GM's deliberate pause (e.g. a table break) is only ever unpaused
 * by that human — this module never touches it. A GM-less run has no human
 * GM present to do that, so the Agent-GM client driving it unpauses the
 * game itself; otherwise the pause overlay blocks every party member's own
 * turn with nobody able to lift it. Scoped to runs `dungeon-runner.mjs`
 * reports as non-GM-hosted (`hostUserId` set) so a normal GM-run table is
 * never affected.
 *
 * #18: called from `startCombat` and every combat turn/round change below,
 * but also — and most importantly — from `startDungeonRun`
 * (ui/dungeon-app.mjs) right as a GM-less run begins. Nothing else in this
 * module ever sets `game.paused`; it comes from Foundry's own core
 * behavior (e.g. the game re-pausing on world reactivation or a GM client
 * reconnecting), which can land at any point, not just mid-combat. Without
 * the run-start call, a run that began already paused had no code path
 * that would ever lift it until its first combat happened to start.
 */
export function unpauseIfGmLessRun(sceneId) {
  if (game.paused && sceneId && getRunState(sceneId)?.hostUserId) {
    game.togglePause(false, { broadcast: true });
  }
}

/** `{ hostilesDefeated, partyDefeated }` — both false while the fight's
 * still going. A party combatant counts as defeated here once it's
 * actually `isDefeated` OR (#580) incapacitated via `isDownedCharacter`
 * (dying/unconscious) -- a downed PC deliberately never gets `isDefeated`
 * set (so a GM can still stabilize them), but once #410 stopped hostile
 * AI from ever attacking a downed PC again, waiting for actual death left
 * combat stalled forever the moment every PC went down -- the state is
 * already terminal from there, since nothing else in this module can
 * change it. A non-character party member (e.g. a summoned ally) still
 * needs the real `isDefeated` flag, same as today -- the dying/
 * stabilization nuance is specific to PF2e player characters, same
 * scoping `isDownedCharacter` itself already uses. */
export function combatSideStatus(combat) {
  const groups = { hostile: [], party: [] };
  for (const c of combat.combatants)
    (c.token?.disposition === -1 ? groups.hostile : groups.party).push(c);
  return {
    hostilesDefeated:
      groups.hostile.length > 0 && groups.hostile.every((c) => c.isDefeated),
    partyDefeated:
      groups.party.length > 0 &&
      groups.party.every((c) => c.isDefeated || isDownedCharacter(c)),
  };
}

/** Cover-item (#96) tokens belonging to this combat's own room/encounter —
 * scoped the same way combatantTokens scopes monster tokens, but read off
 * `combat`'s own flag instead of taking flagKey/flagValue as parameters,
 * since resolveCombat only ever has the Combat itself to go on. Cover items
 * are never Combatants (they don't act, so they never join initiative),
 * so they can't be found via `combat.combatants` the way NPCs are below —
 * this scans the scene's tokens directly instead. */
function coverItemTokensForCombat(combat) {
  const scene = combat.scene;
  const dungeonSlot = combat.getFlag(MODULE_ID, "dungeonSlot");
  const encounterId = combat.getFlag(MODULE_ID, "encounterId");
  if (!scene || (dungeonSlot == null && encounterId == null)) return [];
  return scene.tokens.filter((t) => {
    if (!t.getFlag(MODULE_ID, "coverItem")) return false;
    if (dungeonSlot != null)
      return t.getFlag(MODULE_ID, "dungeonSlot") === dungeonSlot;
    return t.getFlag(MODULE_ID, "encounterId") === encounterId;
  });
}

/**
 * Grants XP on victory, then deletes the Combat either way — and, since this
 * fight is now genuinely over regardless of outcome, cleans up every
 * non-party combatant. What "cleans up" means now depends on what the
 * combatant is (#172):
 *
 * - A defeated hostile in a real dungeon run (`dungeonSlot`-flagged combat)
 *   becomes a lootable corpse: its own gear (granted at spawn time by
 *   `spawnCreatures`) is copied onto a freshly created PF2e `loot`-type
 *   actor, the encounter's token is repointed and linked to it, and the
 *   original npc-type actor is deleted — so the corpse persists on the scene
 *   for players to loot via PF2e's native loot sheet instead of vanishing. A
 *   defeated hostile with nothing actually worth looting (no coins, no item
 *   matching `LOOTABLE_ITEM_TYPES`) skips the loot actor entirely and falls
 *   back to the plain delete below, to avoid littering the world with empty
 *   loot piles nobody needs to open. A defeated hostile in a standalone
 *   encounter (`encounterId`-only, no dungeon run) always falls back to the
 *   plain delete too (#15) — cleanup for a converted corpse only ever runs
 *   from the dungeon-run UI flow (`teardownDungeonRun`'s Abandon-time sweep,
 *   `sweepCompletedDungeonScene`'s goal-room sweep), so a standalone
 *   encounter's corpse would otherwise sit on its scene with no cleanup
 *   mechanism reachable, ever.
 * - Everything else non-party (a surviving player-summoned ally, an
 *   undefeated hostile the party fled from) keeps the original, pre-#172
 *   behavior: its token and underlying Actor are deleted outright.
 *   `spawnCreatures`/`spawnBuiltCreature` (foundry-api.mjs) always create a
 *   real, permanent world Actor for an encounter's monsters, and before any
 *   of this existed the only place that ever cleaned one up was
 *   `teardownDungeonRun` at Abandon time — confirmed live: 8 had piled up in
 *   the real world from ordinary completed play before that cleanup was
 *   added.
 *
 * Cover items (#96) are unaffected by any of this — they're scenery, not
 * creatures, and never carried treasure, so `spawnCoverItems`'s tokens/
 * Actors still get the exact same immediate delete they always did.
 *
 * Known gap (tracked as a follow-up, not fixed here): an un-looted corpse
 * from a normally-*completed* run (the dungeon simply finishes, rather than
 * being abandoned) has no cleanup trigger at all — `teardownDungeonRun`'s
 * sweep only fires on Abandon/reset, so a completed run's loot actors can
 * still accumulate in the world indefinitely.
 * https://github.com/cory-johannsen/foundry-deck-of-many-things/issues/204
 */
async function resolveCombat(combat, outcome, api) {
  const scene = combat.scene;
  const partyIds = partyActorIds();
  // #15: only a real dungeon run has a reachable cleanup trigger for a
  // converted corpse (teardownDungeonRun's Abandon-time sweep,
  // sweepCompletedDungeonScene's goal-room sweep — both fire only for a
  // dungeonSlot-flagged scene). A standalone encounter (encounterId-only)
  // has no such trigger, so its defeated hostiles never convert to loot.
  const isDungeonRunCombat = combat.getFlag(MODULE_ID, "dungeonSlot") != null;
  const npcCombatants = combat.combatants.filter(
    (c) => c.actor?.id && !partyIds.has(c.actor.id),
  );
  // A defeated hostile becomes a lootable corpse (see the conversion step
  // below) instead of being deleted outright — everything else non-party
  // (a surviving player-summoned ally, an undefeated hostile the party
  // fled from) keeps the pre-#172 immediate-delete behavior unchanged.
  const defeatedHostileCombatants = npcCombatants.filter(
    // #476: also count a hostile at 0 HP that nothing flagged defeated
    // (it died through a damage path this module doesn't automate). A
    // living unflagged hostile (the party fled) still pays no XP.
    (c) =>
      (c.isDefeated || (c.actor?.system?.attributes?.hp?.value ?? 1) <= 0) &&
      c.token?.disposition === -1,
  );
  const otherNpcCombatants = npcCombatants.filter(
    (c) => !defeatedHostileCombatants.includes(c),
  );
  const npcTokenIds = otherNpcCombatants.map((c) => c.tokenId).filter(Boolean);
  const npcActorIds = [...new Set(otherNpcCombatants.map((c) => c.actor.id))];
  const coverTokens = coverItemTokensForCombat(combat);
  const coverTokenIds = coverTokens.map((t) => t.id);
  const coverActorIds = [
    ...new Set(coverTokens.map((t) => t.actor?.id).filter(Boolean)),
  ];

  if (outcome === "victory") {
    // #172 review: XP is for hostiles actually defeated, not every hostile
    // in the fight — a monster the party fled from without killing
    // shouldn't pay full XP. Reuses defeatedHostileCombatants (built above
    // for the loot-conversion work) rather than a bare disposition filter.
    const hostileLevels = defeatedHostileCombatants.map(
      (c) => c.actor?.system?.details?.level?.value ?? 0,
    );
    const partyLevel = await api.partyLevel();
    const totalXp = totalCombatXp(hostileLevels, partyLevel);
    await api.grantPartyXp(totalXp, "combat");
  }
  // #172: a defeated hostile's own gear (granted at spawn time — see
  // spawnCreatures) becomes real, player-lootable treasure instead of
  // vanishing with its actor. Foundry document types are immutable after
  // creation (confirmed live: actor.update({type: "loot"}) silently no-ops)
  // — so this creates a fresh loot-type actor from the defeated actor's own
  // data and repoints the existing token at it, rather than updating in
  // place. Ownership defaults to full Owner so any player can loot it
  // immediately with no further GM permission step. A defeated hostile with
  // nothing actually worth looting (ineligible creature type, or an
  // eligible one whose roll came up empty) falls back to the pre-#172
  // immediate delete instead — an empty loot actor is needless permanent
  // world clutter nobody needs to open, and only worsens the un-looted-
  // corpse accumulation tracked in #204.
  //
  // Original actor ids are captured before the loop below repoints any
  // token: `Combatant#actor` resolves through its token, so reading
  // `.actor.id` *after* a repoint would return the new loot actor's own id
  // instead of the original hostile's — live-reproduced by Task 5's
  // verifier as a real bug where the just-created loot actor got deleted
  // instead of the orphaned original, leaving the corpse token pointed at
  // nothing.
  const originalActorIdByCombatantId = new Map(
    defeatedHostileCombatants.map((c) => [c.id, c.actor?.id]),
  );
  const lootedOriginalActorIds = [];
  const emptyDefeatedTokenIds = [];
  const emptyDefeatedActorIds = [];
  for (const combatant of defeatedHostileCombatants) {
    const originalActorId = originalActorIdByCombatantId.get(combatant.id);
    const source = combatant.actor.toObject();
    const lootItems = source.items.filter((i) =>
      LOOTABLE_ITEM_TYPES.includes(i.type),
    );
    const coinsObj = combatant.actor.inventory?.coins?.toObject?.() ?? {
      ...(combatant.actor.inventory?.coins ?? {}),
    };
    const hasLoot =
      lootItems.length > 0 ||
      Object.values(coinsObj).some((v) => Number(v) > 0);
    if (!isDungeonRunCombat || !hasLoot) {
      if (combatant.tokenId) emptyDefeatedTokenIds.push(combatant.tokenId);
      if (originalActorId) emptyDefeatedActorIds.push(originalActorId);
      continue;
    }
    if (originalActorId) lootedOriginalActorIds.push(originalActorId);
    const [lootActor] = await Actor.createDocuments([
      {
        ...source,
        _id: undefined,
        type: "loot",
        name: `${combatant.actor.name} (corpse)`,
        items: lootItems,
        ownership: { default: 3 },
      },
    ]);
    // actorLink: true in the same update — the loot actor is now 1:1
    // dedicated to this one token/corpse, so there's no reason for the
    // token to stay unlinked. Left unlinked, `token.actor` (what a player
    // actually opens) stays a synthetic ActorDelta merge of this freshly
    // created loot actor plus the token's own per-token delta — which, for
    // a combat-defeated creature, still carries its hp-at-death and
    // dying/unconscious/off-guard condition items from PF2e's own combat
    // resolution, so a player could still see stale hp/conditions layered
    // on top of an otherwise-clean loot actor. Linking makes `token.actor`
    // resolve directly to the world actor with no delta merge at all.
    await combatant.token.update({ actorId: lootActor.id, actorLink: true });
  }
  const dedupedLootedOriginalActorIds = [...new Set(lootedOriginalActorIds)];
  if (dedupedLootedOriginalActorIds.length)
    await Actor.deleteDocuments(dedupedLootedOriginalActorIds);
  await combat.delete();
  const allNpcTokenIds = [...npcTokenIds, ...emptyDefeatedTokenIds];
  const allNpcActorIds = [
    ...new Set([...npcActorIds, ...emptyDefeatedActorIds]),
  ];
  if (allNpcTokenIds.length && scene)
    await scene.deleteEmbeddedDocuments("Token", allNpcTokenIds);
  if (allNpcActorIds.length) await Actor.deleteDocuments(allNpcActorIds);
  if (coverTokenIds.length && scene)
    await scene.deleteEmbeddedDocuments("Token", coverTokenIds);
  if (coverActorIds.length) await Actor.deleteDocuments(coverActorIds);
}

/** Shared by both the manual GM buttons and the automatic hooks below. */
export async function resolveSlotCombat(
  scene,
  slot,
  outcome,
  api = makeFoundryApi(),
) {
  const combat = getCombatForRoom(scene, slot);
  if (!combat) return;
  await resolveCombat(combat, outcome, api);
}

/**
 * Guards against `autoResolveIfDecided` running more than once concurrently
 * for the same combat. Foundry does not await the async hook callbacks this
 * module registers (`updateActor`/`updateCombatant`) — when several
 * combatants are defeated close together (routine under fully-automated
 * play: agent-controlled turns and cascading kills happen far faster than a
 * human GM ever clicks through them), each defeat's hook firing can reach
 * `autoResolveIfDecided` before an earlier firing's own `resolveCombat` call
 * has finished, and the `game.combats.has(combat.id)` check alone doesn't
 * close that window — the combat document isn't deleted until near the end
 * of `resolveCombat`, well after several concurrent callers may have
 * already read it. The result, confirmed live: several overlapping
 * `resolveCombat` calls each doing their own read-increment-write on the
 * same party members' XP, racing each other and losing updates — see
 * BUG-4 in docs/bugs.md.
 *
 * The check-and-claim below is safe with no lock needed beyond a plain
 * `Set`: JS has no true parallelism, so nothing can run between the
 * `.has()` check and the `.add()` claim on the same line — whichever
 * invocation's hook callback is scheduled first always wins the claim
 * before any other can observe it unclaimed, even though the two
 * invocations themselves originate from independent, unawaited hook
 * dispatches.
 */
const resolvingCombatIds = new Set();

/**
 * If `combat` has just been decided (one side wholly defeated), grants
 * rewards and deletes it, returning `{ outcome, dungeonSlot, scene }` for the
 * caller to advance the room with (`dungeonSlot` is null for a standalone
 * `encounterId`-flagged combat, which has no room to advance). Returns null
 * while the fight's still undecided, if another update already resolved it
 * first (`game.combats` no longer has it), or if another concurrent call is
 * already resolving it right now (see `resolvingCombatIds` above).
 */
async function autoResolveIfDecided(combat) {
  if (!game.user.isGM || !game.combats.has(combat.id)) return null;
  if (resolvingCombatIds.has(combat.id)) return null;
  const { hostilesDefeated, partyDefeated } = combatSideStatus(combat);
  if (!hostilesDefeated && !partyDefeated) return null;
  resolvingCombatIds.add(combat.id);
  try {
    const outcome = hostilesDefeated ? "victory" : "defeat";
    const dungeonSlot = combat.getFlag(MODULE_ID, "dungeonSlot") ?? null;
    const scene = combat.scene;
    await resolveCombat(combat, outcome, makeFoundryApi());
    return { outcome, dungeonSlot, scene };
  } finally {
    resolvingCombatIds.delete(combat.id);
  }
}

/** The module's own combat currently involving `actorId`, if any — shared
 * by every hook target below that needs to find "is this actor's combat
 * decided yet" from something other than the Combat/Combatant document
 * itself. */
function findModuleCombatForActor(actorId) {
  return game.combats.find(
    (c) => isModuleCombat(c) && c.combatants.some((cb) => cb.actorId === actorId),
  );
}

/** Hook target for `updateActor` — module.mjs registers this. */
export function maybeResolveCombatForActor(actor) {
  const combat = findModuleCombatForActor(actor.id);
  return combat ? autoResolveIfDecided(combat) : null;
}

/** Hook target for `createItem` — module.mjs registers this, for every
 * item creation in the game, not just combat-relevant ones; filtered to
 * condition items before doing anything else. #580: a downed PC's
 * dying/unconscious condition is applied as a brand-new embedded Item on
 * its actor (`actor.increaseCondition`) -- confirmed live that this fires
 * Foundry's `createItem` hook, never `updateActor` (0 events observed for
 * the latter, 4 for the former, in a direct live test before this plan
 * was written). Without this hook, `combatSideStatus`'s Task 1 fix is
 * correct but never actually re-checked at the moment a PC goes down --
 * nothing else in this module calls `autoResolveIfDecided` on a plain
 * condition change. */
export function maybeResolveCombatForCondition(item) {
  if (item.type !== "condition") return null;
  const actor = item.parent;
  if (!actor) return null;
  const combat = findModuleCombatForActor(actor.id);
  return combat ? autoResolveIfDecided(combat) : null;
}

/**
 * #476: marks every 0-HP NPC combatant of `actor` defeated, whatever damage
 * path got it there (this module only flags defeat from its own automated
 * paths). Only the single active GM client acts -- toggleDefeated toggles,
 * so two GM clients both acting would undo each other. Characters are
 * skipped (their dying handling already exists).
 */
export async function autoDefeatZeroHpNpcs(actor) {
  if (!game.users?.activeGM?.isSelf) return;
  if (!actor || actor.type === "character") return;
  if ((actor.system?.attributes?.hp?.value ?? 1) > 0) return;
  const combats = game.combats.filter(
    (c) =>
      isModuleCombat(c) && c.combatants.some((cb) => cb.actorId === actor.id),
  );
  for (const combat of combats) {
    for (const combatant of combat.combatants) {
      if (combatant.actorId !== actor.id) continue;
      if (combatant.isDefeated || combatant.actor?.type === "character")
        continue;
      await applyDefeatIfReducedToZero(combatant);
    }
  }
}

/** Hook target for `updateCombatant` — module.mjs registers this. */
export function maybeResolveCombatForCombatant(combatant, changes) {
  if (!("defeated" in changes)) return null;
  const combat = combatant.parent;
  return combat && isModuleCombat(combat) ? autoResolveIfDecided(combat) : null;
}

// --- ITEM-8: automating a non-player combatant's own turn ---------------

const AUTO_PLAY_DELAY_MS = 700;
// #479: how long an agent-controlled combatant's turn pauses between one
// applied action and the next decision, on both the agent-decision path
// (runAgentDecisionLoop) and the heuristic fallback (playHeuristicTurn) --
// so a turn's actions resolve visibly one at a time instead of all at
// once. Shared by both paths rather than two separate constants.
// Deliberately a different value from AUTO_PLAY_DELAY_MS so a test spying
// on setTimeout by delay value can never confuse the two.
// DEFAULT value (ms); the live value is the world setting
// `actionPaceDelayMs`, read at call time by actionPaceDelayMs().
const ACTION_PACE_DELAY_MS = 1200;

const actionPaceDelayMs = () =>
  readPacingSetting("actionPaceDelayMs", ACTION_PACE_DELAY_MS);

// How long an agent-controlled combatant's turn waits for an external
// decision (via getPendingAgentTurn/applyAgentDecision, Task 3) before
// falling back to the heuristic for the rest of that turn — re-armed after
// every applied action, not just once per turn, so a poller that stalls
// mid-turn (rather than never starting at all) still recovers.
export const AGENT_TIMEOUT_MS = 45000;

/**
 * Waits AGENT_TIMEOUT_MS, then fires the heuristic fallback for `combatant`
 * — but only if this exact timer is still the freshest thing watching this
 * exact turn. It is NOT a guarantee that nothing else happened in the
 * meantime: `applyAgentDecision` arms a fresh timer after every action, so a
 * multi-action turn can have several of these outstanding at once. What it
 * does guarantee is that a superseded timer bails out silently instead of
 * firing on top of a turn something else already advanced — it captures the
 * combat's `round`/`turn` and the per-turn write counter at arm time, and on
 * fire, re-checks the combatant is still current, the round/turn haven't
 * moved on (catches the same combatant's *next* turn, not just a different
 * one), and the counter is unchanged (catches a decision already applied by
 * this same turn's more-recently-armed timer or `runAgentDecisionLoop`).
 */
export async function armAgentTimeout(combat, combatant) {
  const armedRound = combat.round;
  const armedTurn = combat.turn;
  const armedCounter =
    currentStoredAgentTurnState(combat, combatant.id)?.counter ?? 0;
  await new Promise((resolve) => setTimeout(resolve, AGENT_TIMEOUT_MS));
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id)
    return;
  if (combat.round !== armedRound || combat.turn !== armedTurn) return;
  const currentCounter =
    currentStoredAgentTurnState(combat, combatant.id)?.counter ?? 0;
  if (currentCounter !== armedCounter) return;
  const warningKey = "PF2EDC.Dungeon.Combat.AgentTimeoutWarning";
  const chatKey = "PF2EDC.Dungeon.Combat.AgentTimeoutChat";
  ui.notifications.warn(game.i18n.format(warningKey, { name: combatant.name }));
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({
    content: game.i18n.format(chatKey, { name: combatant.name }),
    whisper: gmIds,
  });
  await playHeuristicTurn(combat, combatant);
}

/**
 * Replaces tools/agent-loop/poll.mjs's external decide-apply loop: calls
 * the GM's configured hosted agent service directly and applies whatever
 * it decides, in-process, using the same getPendingAgentTurn/
 * applyAgentDecision this file already exposes on module.api. Runs
 * alongside armAgentTimeout (not instead of it) — armAgentTimeout is the
 * only thing that ever falls back to the heuristic, so a rejected fetch,
 * an unconfigured service, or a slow response all resolve the same way
 * they already do today: silently, letting the timeout's existing
 * warning/fallback fire. `deps` is test-only dependency injection (see
 * this task's own test) — production callers never pass it.
 */
export async function runAgentDecisionLoop(
  combat,
  combatant,
  {
    fetchDecision = fetchCombatDecision,
    fetchCandidates = fetchCombatCandidates,
    getPending = getPendingAgentTurn,
    applyDecision = applyAgentDecision,
    armTimeout = armAgentTimeout,
  } = {},
) {
  const baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
  const apiKey = game.settings.get(MODULE_ID, "agentServiceApiKey");
  if (!baseUrl) return;

  let pending = await getPending(combat);
  while (pending) {
    // #616: an unaware hostile has nothing to decide; end its turn now rather
    // than asking the agent service (or waiting out the fallback timeout).
    if (isUnawareHostile(combat, combatant)) {
      await endUnawareTurn(combat, combatant);
      return;
    }
    // #909: once per turn, when there's a non-empty maneuver vocabulary and
    // no picks have been fetched yet this turn, ask the reasoning-model
    // endpoint which (if any) maneuvers to propose, persist the result onto
    // the same combat-flag turn state mapIncrement/actionsRemaining already
    // use, then rebuild `pending` so its deterministic candidate list picks
    // the persisted picks back up (applyAgentDecision's own internal
    // getPendingAgentTurn call does the same rebuild). A failed call
    // persists `[]` so it is never retried this turn. A pendingTurn with no
    // maneuverVocabulary never touches the turn state at all.
    // #910: the feat vocabulary rides along in the same single call.
    // #915: so do the NPC save abilities -- still one call, and none at all
    // when every vocabulary is empty. #932: and the NPC movement abilities.
    // #933: and the NPC Strike-plus abilities. #934: and the NPC
    // self-buff/self-heal abilities.
    if (
      pending.maneuverVocabulary?.length ||
      pending.featVocabulary?.length ||
      pending.npcAbilityVocabulary?.length ||
      pending.npcMoveVocabulary?.length ||
      pending.npcStrikeVocabulary?.length ||
      pending.npcSelfVocabulary?.length
    ) {
      const turnState = getAgentTurnState(combat, pending.combatantId);
      if (turnState.maneuverPicks === null) {
        let picks = [];
        try {
          const response = await fetchCandidates({
            baseUrl,
            apiKey,
            context: pending.context,
            vocabulary: [
              ...(pending.maneuverVocabulary ?? []),
              ...(pending.featVocabulary ?? []),
              ...(pending.npcAbilityVocabulary ?? []),
              ...(pending.npcMoveVocabulary ?? []),
              ...(pending.npcStrikeVocabulary ?? []),
              ...(pending.npcSelfVocabulary ?? []),
            ],
          });
          picks = Array.isArray(response?.picks) ? response.picks : [];
        } catch (err) {
          console.error("agent-service: combat-candidates call failed:", err.message);
        }
        await setAgentTurnState(combat, pending.combatantId, {
          ...turnState,
          maneuverPicks: picks,
        });
        // That write bumped the turn-state counter, which invalidates the
        // fallback timer armed at turn start -- re-arm it (same as
        // applyAgentDecision after every action) so a later failure here
        // still falls back to the heuristic instead of stalling the turn.
        armTimeout(combat, combatant);
        pending = await getPending(combat);
        if (!pending) return;
      }
    }
    let decision;
    try {
      // actorProfile is reserved for future actor-complexity tiering; the
      // v1 service ignores it, but the request contract always carries it.
      decision = await fetchDecision({
        baseUrl,
        apiKey,
        context: { ...pending.context, actorProfile: { tier: "standard" } },
      });
    } catch (err) {
      console.error("agent-service: combat-decision call failed:", err.message);
      return;
    }
    try {
      pending = await applyDecision(
        combat,
        pending.combatantId,
        decision.candidateId,
        decision.rationale,
      );
    } catch (err) {
      console.error("agent-service: applyAgentDecision failed:", err.message);
      return;
    }
    if (pending) {
      await new Promise((resolve) => setTimeout(resolve, actionPaceDelayMs()));
    }
  }
}

/** Every other still-alive combatant on the opposing side (token disposition
 * differs from `combatant`'s own) — "opposing side" here is just disposition,
 * the same two-bucket split combatSideStatus already uses. */
function combatantOpponents(combat, combatant) {
  const mySide = combatant.token?.disposition;
  return combat.combatants.filter(
    (c) =>
      c.id !== combatant.id &&
      !c.isDefeated &&
      c.token &&
      c.token.disposition !== mySide,
  );
}

/** #410: true for a player character who is currently unconscious or dying.
 * Monsters/NPCs are never "downed" for targeting purposes. */
function isDownedCharacter(combatant) {
  if (combatant.actor?.type !== "character") return false;
  return Array.from(combatant.actor?.conditions ?? []).some(
    (c) => c.slug === "unconscious" || c.slug === "dying",
  );
}

/** `combatantOpponents` minus downed player characters -- who an AI may
 * choose to attack/target. Physical presence (blocking, landing) must keep
 * using the unfiltered `combatantOpponents`. */
function combatantTargets(combat, combatant) {
  return detectableOpponents(combat, combatant).filter(
    (c) => !isDownedCharacter(c),
  );
}

/** #616: `combatantOpponents` minus any opponent that `combatant` has not
 * observed per the combat's stealth detection matrix (keyed sneaker id ->
 * hostile id). Combatants absent from the matrix are always observed, so a
 * no-sneaker combat is unchanged and party-side targeting of hostiles is
 * unaffected. Targeting only: physical blocking must keep using the
 * unfiltered `combatantOpponents`. */
function detectableOpponents(combat, combatant) {
  const matrix = combat.getFlag?.(MODULE_ID, "detection");
  const opponents = combatantOpponents(combat, combatant);
  if (!matrix) return opponents;
  return opponents.filter((c) =>
    canTargetState(stateFor(matrix, c.id, combatant.id)),
  );
}

/** #616: re-resolve an opponent by id for executing an agent decision, under
 * the same detection filter that built the candidates, so a stale candidate
 * id can never resolve to an unobserved PC. */
function resolveOpponentForTurn(combat, combatant, id) {
  return detectableOpponents(combat, combatant).find((c) => c.id === id);
}

/** Every other still-alive combatant on `combatant`'s own side — the
 * mirror image of `combatantOpponents`, added for #126's ally-aware area
 * spell placement scoring (which opponents an area candidate catches is
 * only half the picture; which allies it would also catch is the other
 * half). */
function combatantAllies(combat, combatant) {
  const mySide = combatant.token?.disposition;
  return combat.combatants.filter(
    (c) =>
      c.id !== combatant.id &&
      !c.isDefeated &&
      c.token &&
      c.token.disposition === mySide,
  );
}

/** Chebyshev (8-directional) grid distance between two tokens' positions, in
 * squares — matches how this module already measures everything else
 * (dungeon-layout.mjs's grid-unit geometry), not true PF2e diagonal-cost
 * movement rules. */
export function chebyshevSquares(a, b, gridSize) {
  const { dx, dy } = footprintGapSquares(a, b, gridSize);
  return Math.max(dx, dy, 0);
}

/** #551: footprint-aware -- the nearest-cell gap, per axis, between the two
 * tokens' rectangles (width/height in cells, default 1), in squares. For two
 * 1x1 tokens this is the |top-left delta| / gridSize exactly. */
function footprintGapSquares(a, b, gridSize) {
  const axis = (aPos, aSize, bPos, bSize) => {
    const aMin = aPos / gridSize;
    const bMin = bPos / gridSize;
    const aMax = aMin + ((aSize ?? 1) - 1);
    const bMax = bMin + ((bSize ?? 1) - 1);
    return Math.max(aMin - bMax, bMin - aMax, 0);
  };
  return { dx: axis(a.x, a.width, b.x, b.width), dy: axis(a.y, a.height, b.y, b.height) };
}

/** #934: PF2e RAW distance in feet between two tokens -- every second
 * diagonal square counts double (Player Core, "Measuring Distance") -- for
 * requirement checks that name a distance ("an enemy within 15 feet"). */
export function pf2eDistanceFeet(a, b, gridSize, gridDistanceFt = 5) {
  const { dx, dy } = footprintGapSquares(a, b, gridSize);
  const diagonal = Math.min(dx, dy);
  const straight = Math.max(dx, dy) - diagonal;
  return (straight + diagonal + Math.floor(diagonal / 2)) * gridDistanceFt;
}

const REACH_EPSILON = 1e-6;

/** #551: whether `action` can reach `target` from `combatant`'s current
 * footprint-aware position. */
function strikeInReach(combatant, target, action, gridSize, gridDistanceFt) {
  const distance = chebyshevSquares(combatant.token, target.token, gridSize);
  const reach = actionReachSquares(action, gridDistanceFt);
  return { inReach: distance <= reach + REACH_EPSILON, distance, reach };
}

/**
 * The nearest hazardous Region to `token`, within 1 square (the only
 * distance `buildMovementCandidates`'s own `hazard.distanceSquares <= 1`
 * check ever cares about — #103), or `null` if none is that close. A
 * hazard is any Region on the scene carrying this module's own
 * `hazardous` flag (per live discussion — GM-placed, deliberate, no
 * attempt to infer danger from PF2e's built-in terrain-flavor or
 * movement-cost region behaviors, which don't reliably signal "worth
 * repositioning away from" on their own: mirrors this module's existing
 * `coverItem`/`trapHazard` token-flag convention, just on a Region
 * instead of a Token). Tests the combatant's own cell first, then its 8
 * Chebyshev-adjacent cells, each at cell *center* (confirmed live
 * `Region#testPoint` needs `{x, y, elevation}` bundled into one point
 * object — passing `elevation` as a second argument, the naive reading of
 * the method's own name, silently returns `false` for every point, a real
 * footgun caught live before it shipped). Returns the matching cell's own
 * top-left corner (`x`, `y`) — the same convention every real token's own
 * position already uses — not its center, since `applyAgentDecision`
 * feeds this straight back into `tokenCell` (a plain `pixel / gridSize`
 * round) to build a synthetic retreat-from target: a center point doesn't
 * round-trip through that to the intended cell, a real off-by-one caught
 * live before it shipped. Recomputed fresh at execution time rather than
 * threaded through the candidate, matching every other tier-resolving
 * function in this file's convention.
 */
function nearestHazardousRegionPoint(scene, token, gridSize) {
  const hazardRegions = (scene?.regions ?? []).filter((r) =>
    r.getFlag(MODULE_ID, "hazardous"),
  );
  if (!hazardRegions.length) return null;
  const elevation = token.elevation ?? 0;
  const gx0 = Math.round(token.x / gridSize);
  const gy0 = Math.round(token.y / gridSize);
  for (let dist = 0; dist <= 1; dist++) {
    for (let dgy = -dist; dgy <= dist; dgy++) {
      for (let dgx = -dist; dgx <= dist; dgx++) {
        if (Math.max(Math.abs(dgx), Math.abs(dgy)) !== dist) continue;
        const gx = gx0 + dgx;
        const gy = gy0 + dgy;
        const testX = gx * gridSize + gridSize / 2;
        const testY = gy * gridSize + gridSize / 2;
        if (
          hazardRegions.some((r) =>
            r.testPoint({ x: testX, y: testY, elevation }),
          )
        ) {
          return { distanceSquares: dist, x: gx * gridSize, y: gy * gridSize };
        }
      }
    }
  }
  return null;
}

/** Reach for one ready action, in squares -- a `reach-N` trait (N in feet)
 * takes priority; otherwise a ranged action's own range increment (feet);
 * otherwise plain melee reach. Confirmed live: a PF2e strike's `.traits`
 * array carries entries like `{name: 'reach-20', ...}`. `.item.system.range`
 * has two live shapes: NPC items use an object `{increment, max}` in feet
 * (`null` increment for melee), while PC weapon items use a plain NUMBER in
 * feet (e.g. 120 for a heavy crossbow) and `null` for melee (#614). Only a
 * finite positive increment counts as ranged; anything else is melee. */
export function actionReachSquares(action, gridDistanceFt) {
  const reachTrait = (action.traits ?? []).find((t) =>
    /^reach-\d+$/.test(t.name ?? ""),
  );
  if (reachTrait) return Number(reachTrait.name.split("-")[1]) / gridDistanceFt;
  const range = action.item?.system?.range;
  const rangeIncrement = typeof range === "number" ? range : range?.increment;
  if (Number.isFinite(rangeIncrement) && rangeIncrement > 0)
    return rangeIncrement / gridDistanceFt;
  return MELEE_REACH_SQUARES;
}

/**
 * True for a spell squarely inside #118's scope: single-target (no `area`,
 * and `target.value` names exactly one creature — not "plus any number of
 * additional creatures", Chain Lightning's multi-target shape, explicitly
 * deferred to a follow-up issue), save-based damage (a `defense.save`
 * statistic and at least one damage instance), and a fixed 1/2/3-action
 * cost (excludes a variable range like "1 to 3" and a ritual-style
 * duration like "1 hour"). Confirmed live against the real bestiary
 * (Spirit Blast, Void Warp, Vitality Lash all match; Chain Lightning,
 * Harm/Heal's variable cost, and no-save utility spells don't). Also
 * excludes any spell with the `healing` trait (#132) — confirmed live that
 * casting a dual-nature heal-the-living/damage-the-undead spell like Heal
 * at a living enemy via this exact save/damage mechanism produces zero
 * effect (a wasted turn, not a harmful one): the resulting damage roll
 * carries ambiguous `kinds: ["damage", "healing"]` that `applyDamage`
 * doesn't resolve on its own. Harm itself has no `healing` trait and stays
 * in scope — it's a genuine damage spell against a living target.
 */
function isSpellInScope(spell) {
  const system = spell.system ?? {};
  if (system.traits?.value?.includes("healing")) return false;
  if (system.area != null) return false;
  const targetValue = system.target?.value ?? "";
  if (!/^1\b/.test(targetValue) || /plus|additional/i.test(targetValue))
    return false;
  if (!system.defense?.save?.statistic) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  return /^[123]$/.test(system.time?.value ?? "");
}

/** Squares a single-target spell reaches, from its free-text `range.value`
 * ("30 feet", confirmed live) — `null` when unparseable, since a spell we
 * can't validate as reachable is safer to leave off the candidate list
 * than to guess a range for. */
function spellRangeSquares(spell, gridDistanceFt) {
  const match = /^(\d+)\s*feet$/i.exec(
    (spell.system?.range?.value ?? "").trim(),
  );
  return match ? Number(match[1]) / gridDistanceFt : null;
}

/**
 * True for a spell squarely inside #174's scope: a dual-nature spell whose
 * SHAPE changes with action cost, not just its magnitude — Harm/Heal-
 * shaped, confirmed live as the only real examples: single-target at 1-2
 * actions, a self-centered area at 3, living creatures take one effect and
 * undead take the opposite. Detected structurally, not by spell name: a
 * genuinely variable cost ("1 to 3"), a `defense.save` statistic, a single
 * damage instance, `target.value` mentioning both "living" and "undead"
 * (the dual-nature signal — #122's own broadened single-target regex also
 * matches Harm/Heal's target text, but doesn't distinguish a dual-nature
 * spell from an ordinary one), and at least one action-glyph tier
 * (`parseActionGlyphTiers`) carrying an `area` — the actual shape-change
 * signal, mirroring #140's `isTierScalingAreaSpellInScope`'s own "at least
 * one parseable override" gate.
 */
function isDualNatureTieredSpellInScope(spell) {
  const system = spell.system ?? {};
  if (!/^[123]\s+to\s+[123]$/.test(system.time?.value ?? "")) return false;
  if (!system.defense?.save?.statistic) return false;
  if (Object.keys(system.damage ?? {}).length !== 1) return false;
  const targetValue = system.target?.value ?? "";
  if (!/living/i.test(targetValue) || !/undead/i.test(targetValue))
    return false;
  const tiers = parseActionGlyphTiers(system.description?.value ?? "");
  return Object.values(tiers).some((t) => t.area != null);
}

/**
 * Which creature type a #174-scoped dual-nature spell's damage side
 * targets — derived from the `healing` trait, the same signal #132 already
 * uses to tell Harm and Heal apart: Heal (has `healing`) heals the living
 * and damages the undead; Harm (no `healing` trait) damages the living and
 * heals the undead.
 */
function dualNatureHarmfulTrait(spell) {
  return spell.system?.traits?.value?.includes("healing") ? "undead" : "living";
}

/**
 * True for a spell squarely inside #175's scope: a target-count-scaling
 * spell whose number of independent targets grows with action cost
 * (Rebuke Death-shaped — "1 living creature per action spent to Cast this
 * Spell", confirmed live), rather than #140's shared area or #174's
 * shape-changing pattern. Detected via `parseTargetCountFormula` directly
 * against the spell's own structured `target.value` field — unlike #140/
 * #174, no description-HTML parsing is needed at all, since PF2e already
 * structures this signal. A genuinely variable cost and at least one
 * damage/healing instance round out the check, mirroring every other
 * variable-cost scope filter in this file.
 */
function isTargetCountSpellInScope(spell) {
  const system = spell.system ?? {};
  if (!/^[123]\s+to\s+[123]$/.test(system.time?.value ?? "")) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  return parseTargetCountFormula(system.target?.value ?? "") != null;
}

/**
 * True for a spell squarely inside #176's scope: an area spell whose lower
 * tiers are ordinary save-scaled damage but whose top tier bypasses the
 * save entirely (Force Rain-shaped — confirmed live: "Creatures in the
 * area don't attempt a saving throw and instead automatically take 20
 * force damage"). Broadens #140's own `burst`/`emanation`-only area-type
 * check to also accept `square` — confirmed live Force Rain's own
 * structured minimum tier is a single 5-foot square, not a burst/
 * emanation, so #140's existing filter never sees it at all regardless of
 * this ticket's own scope (no risk of double-matching). A genuinely
 * variable cost, a save statistic (present for the lower, save-scaled
 * tiers even though the top tier ends up bypassing it), a damage instance,
 * and at least one parsed tier actually flagged `noSave` (the real
 * shape-defining signal, mirroring #140's own "at least one parseable
 * override" gate) round out the check.
 */
function isAutoHitAreaSpellInScope(spell) {
  const system = spell.system ?? {};
  const areaType = system.area?.type;
  if (areaType !== "burst" && areaType !== "emanation" && areaType !== "square")
    return false;
  if (!system.defense?.save?.statistic) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  if (!/^[123]\s+to\s+[123]$/.test(system.time?.value ?? "")) return false;
  const tiers = parseAutoHitAreaTiers(system.description?.value ?? "");
  return Object.values(tiers).some((t) => t.noSave);
}

/**
 * Every cost tier of a #176-scoped auto-hit-at-max-tier area spell, keyed
 * by cost — unlike #140's `resolveAreaSpellTiers`, every tier (including
 * the minimum) comes from `parseAutoHitAreaTiers` directly, since Force
 * Rain's own action-glyph clauses reliably carry a damage phrase at every
 * tier, even the one with no `@Template` enricher; only `radiusFeet` falls
 * back to the spell's own structured `system.area` when a tier's clause
 * has no `@Template` of its own (true for the minimum tier). A structured
 * `area.type` of `"square"` means a single grid cell — a *footprint size*,
 * not a radius-from-center the way `burst`/`emanation`'s `value` is —
 * confirmed live Force Rain's own minimum tier is exactly this shape
 * ("a single 5-foot square"), so treating its `value` as a radius would
 * wrongly pull in the center's neighbors too; it resolves to radius 0
 * (the chosen center only) instead. A hypothetical minimum tier with a
 * genuine `burst`/`emanation` structured area (no real example exists
 * today) still falls back to that area's own `value` as a true radius,
 * matching #140's established convention.
 */
function resolveAutoHitAreaTiers(spell) {
  const system = spell.system ?? {};
  const parsed = parseAutoHitAreaTiers(system.description?.value ?? "");
  const tiers = {};
  for (const [costStr, tier] of Object.entries(parsed)) {
    const cost = Number(costStr);
    const radiusFeet = tier.area
      ? tier.area.value
      : system.area?.type === "square"
        ? 0
        : (system.area?.value ?? 0);
    tiers[cost] = {
      cost,
      radiusFeet,
      noSave: tier.noSave,
      damage: tier.noSave
        ? []
        : [{ formula: tier.damageFormula, type: tier.damageType }],
      flatDamage: tier.noSave ? tier.flatDamage : null,
      damageType: tier.damageType,
    };
  }
  return tiers;
}

/**
 * True for a spell squarely inside #122's *fixed-at-minimum-cost* scope:
 * otherwise shaped exactly like #118's single-target save-based damage
 * spells, but with a genuinely variable `time.value` ("1 to 3", not "1 to
 * 3 rounds"-style duration text) instead of a fixed 1/2/3 — #122 always
 * casts at the cheapest tier, never the more powerful multi-action
 * versions (a real, disclosed limitation; full multi-tier support is a
 * follow-up issue). `target.value` is broadened from #118's exact `"1
 * creature"` match to also accept Harm/Heal's own phrasing ("1 living
 * creature or 1 willing undead creature") — confirmed live this still
 * excludes every count-scaling case in the real spell pool ("1 to 3
 * willing creatures", "1 or more creatures", "1 creature per action
 * spent...") because they either end in a plural "creatures" or have
 * trailing text after the final "creature"/"undead", neither of which
 * this pattern allows. Also excludes any spell with the `healing` trait
 * (#132) — Heal itself matches this filter's other criteria exactly (it's
 * variable-cost, has `defense.save`, and non-empty `damage`), but confirmed
 * live that casting it at a living enemy this way produces zero effect
 * rather than damage, since its damage roll carries ambiguous
 * `kinds: ["damage", "healing"]` — Harm has no `healing` trait and stays
 * in scope. Also excludes any #174-scoped dual-nature tiered spell (Harm
 * itself, once #174 shipped) — superseded by its own dedicated multi-tier
 * pathway, which this fixed-at-minimum-cost filter would otherwise offer
 * as a redundant, strictly-worse 1-action-only duplicate candidate.
 */
function isVariableCostSpellInScope(spell) {
  const system = spell.system ?? {};
  if (system.traits?.value?.includes("healing")) return false;
  if (isDualNatureTieredSpellInScope(spell)) return false;
  if (system.area != null) return false;
  const targetValue = system.target?.value ?? "";
  if (
    !/^1(\s\w+)*\screature(\sor\s1(\s\w+)*\s(creature|undead))?$/i.test(
      targetValue,
    )
  )
    return false;
  if (!system.defense?.save?.statistic) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  return /^[123]\s+to\s+[123]$/.test(system.time?.value ?? "");
}

/** The cheapest action-cost tier of a #122-scoped variable-cost spell
 * ("1 to 3" → 1), or `null` if unparseable. */
function minimumVariableCost(spell) {
  const match = /^([123])\s+to\s+[123]$/.exec(spell.system?.time?.value ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Squares a #122-scoped spell reaches *at its minimum cost tier* — reuses
 * `spellRangeSquares` for an ordinary "N feet" value, but `system.range`
 * itself doesn't vary by tier (PF2e stores only one range per spell item),
 * so a spell whose range genuinely changes with cost (Harm/Heal: touch at
 * 1 action, 30 feet at 2-3) shows `"varies"` here instead of a real value —
 * confirmed live, across four sampled spells (Harm, Heal, Soul Cutter,
 * Spirit Ward), that "varies" reliably means touch/adjacent-only at the
 * cheapest tier, read directly from each spell's own tier-1 description
 * text. A literal `"touch"` range value (not tied to variable cost at all)
 * gets the same melee-reach treatment.
 */
function minimumTierRangeSquares(spell, gridDistanceFt) {
  const rangeValue = (spell.system?.range?.value ?? "").trim().toLowerCase();
  if (rangeValue === "touch" || rangeValue === "varies")
    return MELEE_REACH_SQUARES;
  return spellRangeSquares(spell, gridDistanceFt);
}

/**
 * True for an area spell squarely inside #119's scope: a `burst` or
 * `emanation` (both simple "radius from a point" shapes — confirmed live
 * against the real bestiary that cone/line/cylinder/square/cube exist too,
 * but need directional geometry this module doesn't compute, so they're
 * deferred to a follow-up issue), save-based damage (a `defense.save`
 * statistic and at least one damage instance), and a fixed 1/2/3-action
 * cost — the same damage/save/cost shape as #118's isSpellInScope, just
 * without the single-target requirement.
 */
function isAreaSpellInScope(spell) {
  const system = spell.system ?? {};
  const areaType = system.area?.type;
  if (areaType !== "burst" && areaType !== "emanation") return false;
  if (!system.defense?.save?.statistic) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  return /^[123]$/.test(system.time?.value ?? "");
}

/**
 * True for a spell squarely inside #140's scope: otherwise shaped exactly
 * like #119's area spells (burst/emanation, save-based damage), but with a
 * genuinely variable `time.value` ("1 to 3") *and* at least one parseable
 * tier override (`parseAreaSpellTierOverrides`) — a variable-cost area
 * spell whose higher tiers can't be parsed at all (no "If you use N
 * actions..." phrasing found) is left to #122's fixed-at-minimum-cost
 * handling instead, same as any other variable-cost spell.
 */
function isTierScalingAreaSpellInScope(spell) {
  const system = spell.system ?? {};
  const areaType = system.area?.type;
  if (areaType !== "burst" && areaType !== "emanation") return false;
  if (!system.defense?.save?.statistic) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  if (!/^[123]\s+to\s+[123]$/.test(system.time?.value ?? "")) return false;
  return (
    Object.keys(parseAreaSpellTierOverrides(system.description?.value ?? ""))
      .length > 0
  );
}

/**
 * Every cost tier of a #140-scoped tier-scaling area spell, keyed by cost —
 * the minimum tier (usually 1 action) comes from the spell's own
 * structured `system.area`/`system.damage` fields (matching #122's
 * "minimum tier = structured data" convention), and any higher tiers come
 * from `parseAreaSpellTierOverrides`'s parsed prose. A spell whose minimum
 * tier isn't itself the cheapest end of its `"N to M"` range (shouldn't
 * happen given `isTierScalingAreaSpellInScope`'s own filtering, but
 * defensive regardless) is skipped for that base entry.
 */
function resolveAreaSpellTiers(spell) {
  const system = spell.system ?? {};
  const tiers = {
    ...parseAreaSpellTierOverrides(system.description?.value ?? ""),
  };
  const minCost = minimumVariableCost(spell);
  if (minCost != null) {
    tiers[minCost] = {
      cost: minCost,
      radiusFeet: system.area?.value ?? 0,
      damage: Object.values(system.damage ?? {}).map((d) => ({
        formula: d.formula,
        type: d.type,
      })),
    };
  }
  return tiers;
}

/**
 * True for a spell squarely inside #120's scope: single-target, attack-roll
 * damage (confirmed live: `system.defense = {passive: {statistic: 'ac'},
 * save: null}` is the real discriminator — `rollAttack`/`rollDamage` exist
 * as methods on every spell document regardless of type, so their mere
 * presence isn't a signal), a non-empty damage instance, and a fixed 1/2/3
 * action cost. Unlike #118's `isSpellInScope`, `target.value` must be
 * exactly `"1 creature"` rather than matched with a loose leading-"1"
 * regex — sampling turned up real spells like Slashing Gust
 * (`"1 or 2 creatures"`) that a looser match would wrongly let through.
 */
function isAttackSpellInScope(spell) {
  const system = spell.system ?? {};
  if (system.area != null) return false;
  if ((system.target?.value ?? "") !== "1 creature") return false;
  if (system.defense?.passive?.statistic !== "ac") return false;
  if (system.defense?.save != null) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  return /^[123]$/.test(system.time?.value ?? "");
}

/**
 * True for a spell squarely inside #121's scope: single-target, save-based,
 * no damage component (a pure debuff/condition spell — #118 already covers
 * save-based *damage* spells), a fixed 1/2/3 action cost, and — the part
 * that actually determines whether this module can do anything useful with
 * it — at least one outcome in its raw description text tags a condition
 * via `parseConditionsByOutcome`'s `@UUID[...]{...}` syntax. A spell that's
 * otherwise in scope but has zero parseable condition tags (a narrative-only
 * effect like "the target must commit to an action") is deliberately
 * excluded rather than offered as a cast-with-no-automated-effect
 * candidate — confirmed live this scope filter would only pick up a
 * meaningful subset of narratively-varied debuff spells, by design.
 */
function isDebuffSpellInScope(spell) {
  const system = spell.system ?? {};
  if (system.area != null) return false;
  if ((system.target?.value ?? "") !== "1 creature") return false;
  if (!system.defense?.save?.statistic) return false;
  if (Object.keys(system.damage ?? {}).length) return false;
  if (!/^[123]$/.test(system.time?.value ?? "")) return false;
  return /@UUID\[Compendium\.pf2e\.conditionitems\.Item\.[^\]]+\]\{[^}]+\}/.test(
    system.description?.value ?? "",
  );
}

/**
 * True for a spell squarely inside #132's scope: single-target, has the
 * `healing` trait (confirmed live this is the real, structured signal for
 * "this spell heals a living creature" — the static `system.damage[].kinds`
 * field is empty at the data level, only the *rolled* result carries
 * `["damage", "healing"]`, so trait is the only reliable pre-cast check),
 * and a fixed 1/2/3 *or* variable ("1 to 3") action cost — Heal itself is
 * variable-cost, so this accepts both shapes and `healSpellCost` picks the
 * right one, reusing #122's minimum-tier convention for the variable case.
 * Deliberately excludes multi-target phrasing ("you and up to 9 allies",
 * Soothing Ballad's shape) — single-ally healing only for v1, matching
 * every other slice's narrow-first pattern; ally buffs (a different
 * mechanic — typically unconditional, no save) are a separate follow-up.
 * Also excludes any #174-scoped dual-nature tiered spell (Heal, once #174
 * shipped) for the same reason #122's filter does — superseded by its own
 * dedicated multi-tier pathway.
 */
function isHealSpellInScope(spell) {
  const system = spell.system ?? {};
  if (!system.traits?.value?.includes("healing")) return false;
  if (isDualNatureTieredSpellInScope(spell)) return false;
  if (system.area != null) return false;
  const targetValue = system.target?.value ?? "";
  if (!/^1\b/.test(targetValue)) return false;
  if (/plus|additional|allies|and up to/i.test(targetValue)) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  const timeValue = system.time?.value ?? "";
  return /^[123]$/.test(timeValue) || /^[123]\s+to\s+[123]$/.test(timeValue);
}

/** The action cost to cast a #132-scoped heal spell — its own fixed 1/2/3
 * value, or (for a variable-cost spell like Heal) the cheapest tier via
 * #122's `minimumVariableCost`. */
function healSpellCost(spell) {
  const timeValue = spell.system?.time?.value ?? "";
  if (/^[123]$/.test(timeValue)) return Number(timeValue);
  return minimumVariableCost(spell);
}

/** The range (in squares) of a #132-scoped heal spell — reuses #122's
 * `minimumTierRangeSquares` for a variable-cost spell like Heal (whose
 * range is "varies", touch-only at the minimum tier), or plain
 * `spellRangeSquares` for a fixed-cost one. */
function healSpellRangeSquares(spell, gridDistanceFt) {
  const timeValue = spell.system?.time?.value ?? "";
  if (/^[123]\s+to\s+[123]$/.test(timeValue)) {
    return minimumTierRangeSquares(spell, gridDistanceFt);
  }
  return spellRangeSquares(spell, gridDistanceFt);
}

/**
 * True for a spell squarely inside #170's scope: single-ally, no save, no
 * damage, a fixed 1/2/3 action cost, and a parseable linked Spell Effect
 * (`parseSpellEffectUuid`) — confirmed live (Mountain Resilience) this is
 * the real, structured signal for "this spell grants an unconditional
 * status effect," the same way the `healing` trait is #132's own signal.
 * Deliberately excludes the `healing` trait (#132's own domain, even
 * though a couple of healing spells also carry a linked Spell Effect —
 * Regenerate, sampled during research), any save-based spell (#121's
 * domain), and multi-target/variable-cost phrasing ("varies",
 * Blessing of Defiance's own shape, or "1 to 3", Infuse Vitality's) — v1
 * is single-target, fixed-cost only, matching every other slice's
 * narrow-first pattern.
 */
function isBuffSpellInScope(spell) {
  const system = spell.system ?? {};
  if (system.traits?.value?.includes("healing")) return false;
  if (isDualNatureTieredSpellInScope(spell)) return false;
  if (system.area != null) return false;
  const targetValue = system.target?.value ?? "";
  if (!/^1\b/.test(targetValue)) return false;
  if (/plus|additional|allies|and up to/i.test(targetValue)) return false;
  if (system.defense?.save?.statistic) return false;
  if (Object.keys(system.damage ?? {}).length) return false;
  if (!/^[123]$/.test(system.time?.value ?? "")) return false;
  return parseSpellEffectUuid(system.description?.value ?? "") != null;
}

/**
 * True for a spell squarely inside #127's scope: a Chain Lightning-shaped
 * chain spell — no area, save-based damage, a fixed 1/2/3 action cost, and
 * a `target.value` of the exact "plus any number of additional creatures"
 * shape #118's `isSpellInScope`/#119's area scope both explicitly exclude.
 * Also requires a parseable hop distance (`parseChainHopDistance`), since
 * without one there's no way to know how far the chain can reach between
 * targets.
 */
function isChainSpellInScope(spell) {
  const system = spell.system ?? {};
  if (system.area != null) return false;
  const targetValue = system.target?.value ?? "";
  if (!/^1\s+creature/i.test(targetValue)) return false;
  if (!/plus/i.test(targetValue) || !/additional/i.test(targetValue))
    return false;
  if (!system.defense?.save?.statistic) return false;
  if (!Object.keys(system.damage ?? {}).length) return false;
  if (!/^[123]$/.test(system.time?.value ?? "")) return false;
  return parseChainHopDistance(system.description?.value ?? "") != null;
}

/**
 * True for a non-spell NPC action item squarely inside #123's scope: an
 * offensive action with a fixed action cost whose description parses as a
 * breath weapon via `parseBreathWeaponEffect` (cone, basic-save damage).
 * Confirmed live this correctly identifies a real dragon's breath weapon
 * among its other action items (reactions, passive traits, multi-strike
 * bundles) without needing to special-case any of those other shapes —
 * they simply never match `parseBreathWeaponEffect`'s enricher pattern.
 */
function isBreathWeaponInScope(item) {
  if (item.type !== "action") return false;
  if (item.system.category !== "offensive") return false;
  if (typeof item.system.actions?.value !== "number") return false;
  return parseBreathWeaponEffect(item.system.description?.value ?? "") != null;
}

/** A readable, stable identifier for a non-spell action item — confirmed
 * live `item.slug` is null for these (unlike a spell, where it reliably
 * falls back to a slugified name), so this derives one from the item's own
 * name instead, falling back to its document id only if that's somehow
 * empty too. */
function actionItemSlug(item) {
  const fromName = (item.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return item.slug || fromName || item.id;
}

/**
 * True for a non-spell NPC action item squarely inside #154's scope: a
 * fixed-action-cost item whose description parses as a multi-strike bundle
 * via `parseMultiStrikeBundle` (Draconic Frenzy-shaped: "N <name> Strike(s)
 * ... in any order"). Naturally mutually exclusive with
 * `isBreathWeaponInScope` — a breath weapon's description carries
 * `@Damage`/`@Template`/`@Check` enrichers and no "Strike(s)" prose at all,
 * confirmed live across the same real dragon bestiary actors used to
 * research this feature.
 */
function isMultiStrikeBundleInScope(item) {
  if (item.type !== "action") return false;
  if (typeof item.system.actions?.value !== "number") return false;
  return parseMultiStrikeBundle(item.system.description?.value ?? "") != null;
}

/**
 * Fuzzy-matches a multi-strike bundle's parsed strike name (e.g. "claw",
 * "horns") against `readyActions`' own slugs/labels, stripping a trailing
 * "s" from both sides before comparing — confirmed live real content uses a
 * plural noun as the strike name ("one horns Strike") even when the actual
 * Strike's own slug/label is singular, and the reverse could just as
 * plausibly occur, so both sides are normalized the same way. Returns the
 * matched ready action, or `null` if none matches.
 */
function matchMultiStrikeActionSlug(name, readyActions) {
  const normalized = name.toLowerCase().replace(/s$/, "");
  return (
    readyActions.find((a) => {
      const slugNormalized = (a.slug ?? "").toLowerCase().replace(/s$/, "");
      const labelNormalized = (a.label ?? "").toLowerCase().replace(/s$/, "");
      return slugNormalized === normalized || labelNormalized === normalized;
    }) ?? null
  );
}

/**
 * The stored recharge state for `itemSlug` on `combatantId`, or `null` if
 * it's never been used this combat (and so is always available). Recharge
 * state persists across rounds/turns (unlike `agentTurnState`, which is
 * per-turn) since a breath weapon's cooldown is measured in rounds — stored
 * under its own flag key, keyed by combatant then ability slug, so
 * multiple combatants' recharging abilities never collide.
 */
function getAbilityRecharge(combat, combatantId, itemSlug) {
  const stored = combat.getFlag(MODULE_ID, "abilityRecharge") ?? {};
  return stored[combatantId]?.[itemSlug] ?? null;
}

/** Rolls `rechargeFormula` and records that `itemSlug` becomes available
 * again once `combat.round` reaches `combat.round + <rolled value>` —
 * called right after a breath weapon is used. An ability with no
 * `rechargeFormula` at all (parsed as `null`) is never recorded and stays
 * always-available. */
async function setAbilityRecharge(
  combat,
  combatantId,
  itemSlug,
  rechargeFormula,
) {
  if (!rechargeFormula) return;
  const roll = await new Roll(rechargeFormula).evaluate();
  const stored = combat.getFlag(MODULE_ID, "abilityRecharge") ?? {};
  const forCombatant = stored[combatantId] ?? {};
  await combat.setFlag(MODULE_ID, "abilityRecharge", {
    ...stored,
    [combatantId]: {
      ...forCombatant,
      [itemSlug]: { availableAtRound: combat.round + roll.total },
    },
  });
}

/** False only while `itemSlug` is still on cooldown for `combatantId`. */
function isAbilityRecharged(combat, combatantId, itemSlug) {
  const recharge = getAbilityRecharge(combat, combatantId, itemSlug);
  if (!recharge) return true;
  return combat.round >= recharge.availableAtRound;
}

/** #915: an actor's own action items (bestiary abilities are always
 * `type: "action"`). */
function actorActionItems(actor) {
  return (
    actor?.itemTypes?.action ??
    Array.from(actor?.items ?? []).filter((i) => i?.type === "action")
  );
}

/**
 * #915: the Foundry-touching half of NPC-ability readiness -- parses each
 * action item with npc-ability-parse.mjs's pure parser, drops anything out
 * of frequency uses or still recharging (the same name-derived slug and
 * `abilityRecharge` store breath weapons use), and splits survivors into
 * area (template / group-range) vs single-target (range) lists. `targets`
 * (opponent/ally combatants) are checked against the system's own
 * `actor.isImmuneTo(item)` -- a mindless creature immune to mental effects
 * is never counted or targeted. Area placements are computed by the caller
 * (getPendingAgentTurn), which owns the canvas.
 */
export function computeReadyNpcAbilities(combat, combatant, targets = []) {
  const readyAreaAbilities = [];
  const readySingleTargetAbilities = [];
  for (const item of actorActionItems(combatant.actor)) {
    const descriptor = parseSaveAbility(item);
    if (!descriptor) continue;
    const uses = descriptor.frequency?.value;
    if (descriptor.frequency && !(typeof uses === "number" && uses > 0)) continue;
    const slug = actionItemSlug(item);
    if (!isAbilityRecharged(combat, combatant.id, slug)) continue;
    const worldTime = globalThis.game?.time?.worldTime ?? 0;
    const immuneIds = targets
      .filter((t) => {
        if (worldTime < getNpcAbilityImmunityUntil(combat, item.id, t.id)) return true;
        // #935: outside the ability's stated targets ("Any non-boggard").
        if (npcAbilityExcludesTarget(descriptor, t.actor)) return true;
        try {
          return t.actor?.isImmuneTo?.(item) === true;
        } catch {
          return false;
        }
      })
      .map((t) => t.id);
    const base = {
      itemId: item.id,
      slug,
      name: item.name,
      mode: descriptor.mode,
      cost: descriptor.cost,
      summary: describeNpcAbility(descriptor),
      affectsAllies: descriptor.affectsAllies,
      immuneIds,
    };
    if (descriptor.shape.areaType) {
      readyAreaAbilities.push({
        ...base,
        areaType: descriptor.shape.areaType,
        distanceFeet: descriptor.shape.distanceFeet,
        rangeFeet: descriptor.shape.rangeFeet ?? null,
      });
    } else {
      readySingleTargetAbilities.push({ ...base, rangeFeet: descriptor.shape.rangeFeet });
    }
  }
  return { readyAreaAbilities, readySingleTargetAbilities };
}

/**
 * True for a non-spell NPC action item squarely inside #202's scope: a
 * reaction (`system.actionType.value === "reaction"`) named "Reactive
 * Strike" or "Attack of Opportunity" (PF2e Remaster renamed the same core
 * mechanic; both names appear across real bestiary content depending on
 * a creature's own publication era) — confirmed live this correctly
 * identifies the single most common reaction across a broad bestiary
 * sample, distinct from every other reaction shape (Twisting Tail,
 * Freezing Blood, Wing Deflection, etc. — #202's own research found these
 * too varied to parse generally, hence the narrow v1 scope).
 */
function isReactiveStrikeInScope(item) {
  if (item.type !== "action") return false;
  if (item.system.actionType?.value !== "reaction") return false;
  return /^(Reactive Strike|Attack of Opportunity)\b/i.test(item.name ?? "");
}

/**
 * Whether `combatantId` has already used their one-per-round reaction
 * this round (#202) — confirmed live PF2e's own system tracks no reaction
 * economy on the actor at all (only `focus`/`mythicPoints` resources
 * exist), so this module tracks it itself, the same per-combatant combat
 * flag shape `abilityRecharge` already uses, keyed by round instead of an
 * item slug (a reaction is per-*creature*, not per-ability, unlike a
 * breath weapon's own independent recharge).
 */
export function getReactionUsed(combat, combatantId, round) {
  const stored = combat.getFlag(MODULE_ID, "reactionUsed") ?? {};
  return stored[combatantId] === round;
}

/** Records that `combatantId` has spent their reaction for `round`. */
export async function markReactionUsed(combat, combatantId, round) {
  const stored = combat.getFlag(MODULE_ID, "reactionUsed") ?? {};
  await combat.setFlag(MODULE_ID, "reactionUsed", {
    ...stored,
    [combatantId]: round,
  });
}

/**
 * Every currently-eligible Reactive Strike opportunity against `mover` —
 * one entry per agent-controlled opponent with an unused reaction this
 * round, an in-scope Reactive Strike/Attack of Opportunity item, and a
 * ready melee Strike action that reaches `mover`'s current position — a
 * ranged action's own range increment doesn't count (#21: PF2e's Reactive
 * Strike is a melee Strike only). Pure detection: takes no action itself,
 * so every trigger source (a ranged attack-roll chat message, an agent's
 * own Stride, a GM's manual check) shares one answer to "who gets to react
 * right now."
 */
export function findReactiveStrikeOpportunities(
  combat,
  mover,
  gridSize,
  gridDistanceFt,
) {
  const opportunities = [];
  // #616: a reactor must have OBSERVED the mover (the mover is the matrix
  // row, the reactor the column) -- not the reverse, which is what
  // `combatantTargets(combat, mover)` filters on.
  const matrix = combat.getFlag?.(MODULE_ID, "detection");
  const reactors = combatantOpponents(combat, mover)
    .filter((c) => !isDownedCharacter(c))
    .filter((c) => canTargetState(stateFor(matrix, mover.id, c.id)));
  for (const reactor of reactors) {
    if (!reactor.getFlag(MODULE_ID, "agentControlled")) continue;
    if (getReactionUsed(combat, reactor.id, combat.round)) continue;
    const item = (reactor.actor?.items ?? []).find(isReactiveStrikeInScope);
    if (!item) continue;
    // #91: reach alone doesn't mean a Reactive Strike can actually land --
    // a reach weapon can measure "in range" straight through a solid wall.
    if (!hasLineOfSight(combat, reactor.token, mover.token)) continue;

    const matched = strikeReactionAt(
      reactor,
      parseReactiveStrikeWeaponRestriction(item.name),
      mover.token,
      gridSize,
      gridDistanceFt,
    );
    if (!matched) continue;

    opportunities.push({ reactor, actionSlug: matched.slug });
  }
  return opportunities;
}

/**
 * #202/#931: the ready melee Strike `reactor` would make against a creature
 * standing at `position` (a token or a token-shaped `{x, y, width,
 * height}`), or null -- the first ready melee Strike whose reach covers that
 * position, restricted to the named attack when `restriction` is given
 * (an "(Jaws Only)" item suffix, or a registry reaction's own limb such as
 * Twisting Tail's tail). A ranged action's range increment never counts
 * (#21: these are melee Strikes).
 */
function strikeReactionAt(reactor, restriction, position, gridSize, gridDistanceFt) {
  const readyActions = (reactor.actor?.system?.actions ?? [])
    .filter((a) => a.type === "strike" && a.ready !== false && !a.item?.isRanged)
    .map((a) => ({
      slug: a.item?.slug ?? a.slug ?? a.label,
      label: a.label,
      reachSquares: actionReachSquares(a, gridDistanceFt),
    }));
  const distanceSquares = chebyshevSquares(reactor.token, position, gridSize);
  const inReachActions = readyActions.filter((a) => distanceSquares <= a.reachSquares);
  if (!inReachActions.length) return null;
  return restriction
    ? matchMultiStrikeActionSlug(restriction, inReachActions)
    : inReachActions[0];
}

/**
 * #931: every (reactor, registry reaction) pair a Strike-kind reaction
 * trigger fires for against `mover` -- #202's shared gates (an
 * agent-controlled, not-downed opponent that OBSERVED the mover, with its
 * reaction unused this round, line of sight, a ready melee Strike in reach,
 * the item's limb restriction) generalized to every Strike reaction in the
 * registry (npc-reactions.mjs).
 *
 * `event.trigger` picks the registry rows (`def.triggers`). For a `move`
 * event, `event.path` is the mover's positions (origin first, destination
 * last) and each reaction fires at `moveTriggerIndex` of its own
 * `moveTrigger` -- reach and line of sight are measured to each position.
 * Every other trigger measures to the mover's current position. `ctx`
 * carries `{ item, actionSlug, triggerIndex, point }`. `event.onlyDisrupting`
 * keeps only reactions that can disrupt the move (Twisting Tail, Wing
 * Rebuff); `event.skipReactorIds` drops reactors already resolved.
 */
function collectStrikeReactionOptions(combat, mover, event, gridSize, gridDistanceFt) {
  const matrix = combat.getFlag?.(MODULE_ID, "detection");
  const skip = event.skipReactorIds ?? null;
  const reactors = combatantOpponents(combat, mover)
    .filter((c) => !isDownedCharacter(c))
    .filter((c) => canTargetState(stateFor(matrix, mover.id, c.id)));
  const options = [];
  for (const reactor of reactors) {
    if (skip?.has(reactor.id)) continue;
    if (!reactor.getFlag?.(MODULE_ID, "agentControlled")) continue;
    if (getReactionUsed(combat, reactor.id, combat.round)) continue;
    for (const { def, item } of reactionItemsFor(reactor.actor)) {
      if (def.kind !== "strike" || !def.triggers.includes(event.trigger)) continue;
      if (event.onlyDisrupting && !def.disrupts) continue;
      const restriction = def.limb ?? parseReactiveStrikeWeaponRestriction(item.name);
      let point = mover.token;
      let triggerIndex = null;
      if (event.trigger === "move") {
        const path = event.path ?? [];
        const inReach = path.map(
          (pos) =>
            !!strikeReactionAt(reactor, restriction, pos, gridSize, gridDistanceFt) &&
            hasLineOfSight(combat, reactor.token, pos),
        );
        triggerIndex = moveTriggerIndex(def.moveTrigger, inReach);
        if (triggerIndex < 0) continue;
        point = path[triggerIndex];
      } else if (!hasLineOfSight(combat, reactor.token, mover.token)) {
        continue;
      }
      const matched = strikeReactionAt(reactor, restriction, point, gridSize, gridDistanceFt);
      if (!matched) continue;
      options.push({ reactor, def, ctx: { item, actionSlug: matched.slug, triggerIndex, point } });
    }
  }
  return options;
}

/** #931: the combatants' initiative order (`combat.turns`), falling back to
 * the combatant collection's own order. */
function initiativeIndexOf(combat) {
  const order = Array.isArray(combat.turns) && combat.turns.length
    ? combat.turns
    : Array.from(combat.combatants ?? []);
  const index = new Map(order.map((c, i) => [c?.id, i]));
  return (id) => index.get(id) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * #931: the agent-service requester the hybrid decision uses when one
 * creature has several eligible reactions for the same trigger -- null (the
 * deterministic fallback) when no agent service is configured. The request
 * reuses /v1/combat-decision's own `{candidates}` contract (no service
 * change), with the reaction's situation in `self`/`reaction` so every
 * provider sees it, and a 5 s timeout instead of the turn decision's 35 s.
 */
function reactionDecisionRequester(combat, reactor, mover, trigger) {
  let baseUrl;
  let serviceKey;
  try {
    baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
    serviceKey = game.settings.get(MODULE_ID, "agentServiceApiKey");
  } catch {
    return null;
  }
  if (!baseUrl) return null;
  return async ({ candidates }) =>
    fetchCombatDecision({
      baseUrl,
      apiKey: serviceKey,
      timeoutMs: REACTION_DECISION_TIMEOUT_MS,
      context: {
        decisionKind: "reaction",
        self: {
          id: reactor.id,
          name: reactor.name,
          hp: reactor.actor?.system?.attributes?.hp?.value ?? null,
          reactionTrigger: trigger,
        },
        opponents: mover ? [{ id: mover.id, name: mover.name }] : [],
        reaction: {
          trigger,
          triggeringCreature: mover?.name ?? null,
          note: "Choose at most one reaction; a creature has one reaction per round. 'decline' keeps it for later this round.",
        },
        roundNumber: combat.round,
        candidates,
        actorProfile: { tier: "standard" },
      },
    });
}

/**
 * #931: the one dispatcher every reaction trigger path calls. `options` are
 * the eligible `[{ reactor, def, ctx }]` for this trigger; they are grouped
 * per reactor (a creature has one reaction per round, so two creatures never
 * compete for one slot), resolved in initiative order, each by the hybrid
 * decision (`decideReaction`), and the winner is handed to `execute(chosen,
 * decision)`. Before each reactor, the economy (`getReactionUsed`) and the
 * mover/reactor being still in the fight are re-checked -- an earlier
 * reactor's Strike may have dropped the mover. Never throws: a failing
 * decision or executor is logged and the remaining reactors still resolve.
 * Returns `[{ reactor, def, ctx, decision, result }]` for what ran.
 */
export async function resolveReactions(combat, event, execute, { requestDecisionFor = null } = {}) {
  const groups = new Map();
  for (const option of event.options ?? []) {
    const list = groups.get(option.reactor.id) ?? [];
    list.push(option);
    groups.set(option.reactor.id, list);
  }
  const initiative = initiativeIndexOf(combat);
  // A move's reactions resolve in path order (the square each fires on),
  // then initiative order -- and none past the square a disrupting reaction
  // stopped the move on.
  const firstIndex = (group) => Math.min(...group.map((o) => o.ctx?.triggerIndex ?? 0));
  const ordered = [...groups.values()].sort(
    (a, b) => firstIndex(a) - firstIndex(b) || initiative(a[0].reactor.id) - initiative(b[0].reactor.id),
  );
  const ran = [];
  let disruptedAt = Infinity;
  for (const group of ordered) {
    const reactor = group[0].reactor;
    try {
      if (firstIndex(group) > disruptedAt) break;
      if (getReactionUsed(combat, reactor.id, combat.round)) continue;
      if (reactor.isDefeated || !reactor.token) continue;
      if (event.mover && (event.mover.isDefeated || !event.mover.token)) break;
      const requestDecision =
        group.length > 1
          ? (requestDecisionFor ?? reactionDecisionRequester)(combat, reactor, event.mover, event.trigger)
          : null;
      const decision = await decideReaction(
        group.map((o) => ({ def: o.def, ctx: o.ctx, option: o })),
        {
          reactorId: reactor.id,
          requestDecision,
          describe: (o) => `${reactor.name}: ${o.def.label} against ${event.mover?.name ?? "the attacker"}`,
        },
      );
      if (!decision.choice) continue;
      const chosen = decision.choice.option;
      const result = await execute(chosen, decision);
      ran.push({ ...chosen, decision, result });
      if (result?.disrupted) disruptedAt = Math.min(disruptedAt, chosen.ctx?.triggerIndex ?? 0);
    } catch (err) {
      console.error(`${MODULE_ID} | #931: resolving ${reactor.name}'s reaction failed:`, err?.message ?? err);
    }
  }
  return ran;
}

/** #931: the GM-only "why" of a reaction -- the model's rationale or the
 * fallback's reason; deterministic single-option reactions carry none. */
function reactionDecisionNote(decision, extra = null) {
  const parts = [];
  if (decision?.source === "model" && decision.rationale) parts.push(decision.rationale);
  else if (decision?.source === "fallback") {
    parts.push(decision.rationale ?? "Several reactions were possible; used the default priority.");
  }
  if (extra) parts.push(extra);
  return parts.join(" ");
}

/** #931: the public announcement for a registry reaction (#202's own line
 * for Reactive Strike, unchanged), plus a GM-only note of why. */
async function postReactionChat(reactor, target, def, note = "") {
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const content =
    def.id === "reactive-strike"
      ? game.i18n.format("PF2EDC.Dungeon.Combat.ReactiveStrikeChat", {
          name: esc(reactor.name),
          target: esc(target.name),
        })
      : game.i18n.format("PF2EDC.Dungeon.Combat.ReactionChat", {
          name: esc(reactor.name),
          reaction: esc(def.label),
          target: esc(target.name),
        });
  await ChatMessage.create({ content: content + reactionGmNoteHtml(note) });
}

/** #931: whether `item` carries its own roll-option + FlatModifier rule
 * elements for `option` (Monster Core's Twisting Tail does: toggling the
 * `twisting-tail` roll option applies the -2 via the system, confirmed live
 * on pf2e 8.5.0). */
function itemHasRollOptionModifier(item, option) {
  const rules = item?.system?.rules ?? [];
  return (
    rules.some((r) => r?.key === "RollOption" && r.option === option) &&
    rules.some((r) => r?.key === "FlatModifier" && (r.predicate ?? []).includes(option))
  );
}

/**
 * #931: executes a Strike-kind reaction -- marks the reaction used first
 * (never a Strike without the economy recorded), rolls the Strike through
 * `rollAndApplyStrikeAtVariant` (Twisting Tail's -2 through the item's own
 * roll option, or an explicit untyped modifier for an older item without
 * the rule element), announces it, and reports whether it disrupted the
 * triggering move: Twisting Tail on a hit, Wing Rebuff when its push
 * succeeded. Returns `{ outcome, disrupted }`.
 */
async function executeStrikeReaction(combat, chosen, mover, decision) {
  const { reactor, def, ctx } = chosen;
  await markReactionUsed(combat, reactor.id, combat.round);
  const extras = { report: {} };
  if (def.rollOption && itemHasRollOptionModifier(ctx.item, def.rollOption)) {
    extras.rollOptions = [def.rollOption];
  } else if (def.penalty) {
    const Modifier = game.pf2e?.Modifier;
    if (typeof Modifier === "function") {
      extras.modifiers = [
        new Modifier({ slug: def.id, label: def.label, modifier: def.penalty, type: "untyped" }),
      ];
    }
  }
  const outcome = await rollAndApplyStrikeAtVariant(combat, reactor, mover, ctx.actionSlug, 0, extras);
  const disrupted =
    def.disrupts === "hit"
      ? isHitOutcome(outcome)
      : def.disrupts === "push"
        ? extras.report.pushed === true
        : false;
  await postReactionChat(reactor, mover, def, reactionDecisionNote(decision));
  return { outcome, disrupted };
}

/** #931: the Strike-reaction pass for one trigger; returns what ran. */
async function resolveStrikeReactions(combat, mover, event) {
  if (!isModuleCombat(combat)) return [];
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const options = collectStrikeReactionOptions(combat, mover, event, gridSize, gridDistanceFt);
  if (!options.length) return [];
  return resolveReactions(combat, { trigger: event.trigger, mover, options }, (chosen, decision) =>
    executeStrikeReaction(combat, chosen, mover, decision),
  );
}

/**
 * #931: the defensive reactions (`acBonus` / `damageReduction`) `reactor`
 * could use against `attacker` for `trigger` -- the shared gates
 * (agent-controlled, not defeated, reaction unused this round, observed
 * the attacker) plus each row's own: Swat Projectile only against a
 * physical ranged attack; Shield Block only with a raised, unbroken,
 * undestroyed shield (PF2e's own requirement -- `applyDamage` refuses a
 * shield block otherwise). `ctxBase` carries the trigger's numbers.
 */
function collectDefensiveReactionOptions(combat, reactor, attacker, trigger, ctxBase) {
  if (!reactor?.getFlag?.(MODULE_ID, "agentControlled")) return [];
  if (reactor.isDefeated || !reactor.actor) return [];
  if (getReactionUsed(combat, reactor.id, combat.round)) return [];
  const matrix = combat.getFlag?.(MODULE_ID, "detection");
  if (attacker && !canTargetState(stateFor(matrix, attacker.id, reactor.id))) return [];
  const options = [];
  for (const { def, item } of reactionItemsFor(reactor.actor)) {
    if (!def.triggers.includes(trigger)) continue;
    if (def.requiresPhysicalRanged && !ctxBase.isPhysicalRanged) continue;
    const ctx = { ...ctxBase, item };
    if (def.kind === "damageReduction") {
      const shield = reactor.actor.attributes?.shield;
      if (!shield?.raised || shield.broken || shield.destroyed) continue;
      ctx.shieldHardness = shield.hardness ?? 0;
      ctx.shieldName = shield.name ?? "shield";
    }
    options.push({ reactor, def, ctx });
  }
  return options;
}

/** #931: the trigger numbers an attack-roll chat message carries. */
function attackReactionContext(attackMessage, outcome) {
  const context = attackMessage?.flags?.pf2e?.context ?? {};
  const roll = attackMessage?.rolls?.[0];
  return {
    rollTotal: roll?.total ?? null,
    dcValue: context.dc?.value ?? null,
    natural: naturalD20(roll),
    outcome,
    isPhysicalRanged: (context.options ?? []).includes("ranged"),
  };
}

/**
 * #931: executes an AC-bonus reaction (Wing Deflection, Ghost Dodge, Swat
 * Projectile) against a resolved attack -- the policy already confirmed the
 * bonus turns the hit into a miss. PF2e bakes an attack's degree of success
 * into its chat card at roll time (CheckRoll), so the card is not rewritten:
 * the reaction is recorded (economy, plus `reactionAttackMisses` keyed by
 * the attack message so the paired damage roll is skipped) and announced.
 * Returns `{ turnedToMiss, newOutcome }`.
 */
async function executeAcBonusReaction(combat, chosen, attacker, decision, { attackMessageId = null } = {}) {
  const { reactor, def, ctx } = chosen;
  await markReactionUsed(combat, reactor.id, combat.round);
  const newOutcome = degreeOfSuccess(Number(ctx.rollTotal), Number(ctx.dcValue) + def.acBonus, ctx.natural);
  if (attackMessageId) {
    const misses = combat.getFlag(MODULE_ID, "reactionAttackMisses") ?? {};
    await combat.setFlag(MODULE_ID, "reactionAttackMisses", {
      ...misses,
      [attackMessageId]: { reactorId: reactor.id, defId: def.id, round: combat.round },
    });
  }
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const content = game.i18n.format("PF2EDC.Dungeon.Combat.ReactionAcBonusChat", {
    name: esc(reactor.name),
    reaction: esc(def.label),
    bonus: def.acBonus,
    attacker: esc(attacker?.name ?? "the attacker"),
  });
  const numbers = `Attack ${ctx.rollTotal} vs AC ${ctx.dcValue} -> ${ctx.dcValue + def.acBonus} (+${def.acBonus} circumstance).`;
  await ChatMessage.create({ content: content + reactionGmNoteHtml(reactionDecisionNote(decision, numbers)) });
  return { turnedToMiss: true, newOutcome };
}

/**
 * #931: AC-bonus reactions against an attack this module rolled itself (an
 * AI attacker's Strike) -- automatic in every mode (spec: the module owns
 * this attack). Returns the outcome the rest of the Strike resolves with:
 * the reaction's adjusted degree when one turned the hit into a miss, else
 * `outcome` unchanged. Never throws.
 */
async function applyTargetedByAttackReactions(combat, attacker, target, attackMessage, outcome) {
  if (!isHitOutcome(outcome) || !target?.getFlag?.(MODULE_ID, "agentControlled")) return outcome;
  try {
    const options = collectDefensiveReactionOptions(
      combat,
      target,
      attacker,
      "targetedByAttack",
      attackReactionContext(attackMessage, outcome),
    );
    if (!options.length) return outcome;
    const ran = await resolveReactions(
      combat,
      { trigger: "targetedByAttack", mover: attacker, options },
      (chosen, decision) => executeAcBonusReaction(combat, chosen, attacker, decision),
    );
    return ran.find((r) => r.result?.turnedToMiss)?.result.newOutcome ?? outcome;
  } catch (err) {
    console.error(`${MODULE_ID} | #931: AC-bonus reaction check failed:`, err?.message ?? err);
    return outcome;
  }
}

/** #931: executes Shield Block -- records the reaction and announces it;
 * the caller passes `shieldBlockRequest: true` to its single `applyDamage`
 * (never a second damage application), and the system applies Hardness and
 * the shield's own damage. */
async function executeShieldBlock(combat, chosen, attacker, decision) {
  const { reactor, def, ctx } = chosen;
  await markReactionUsed(combat, reactor.id, combat.round);
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const content = game.i18n.format("PF2EDC.Dungeon.Combat.ReactionChat", {
    name: esc(reactor.name),
    reaction: esc(def.label),
    target: esc(attacker?.name ?? "the attacker"),
  });
  const numbers = `${ctx.incomingDamage} damage vs ${ctx.shieldName} Hardness ${ctx.shieldHardness}.`;
  await ChatMessage.create({ content: content + reactionGmNoteHtml(reactionDecisionNote(decision, numbers)) });
  return { shieldBlock: true };
}

/** #931: whether `target` Shield Blocks this hit from an AI attacker
 * (automatic in every mode). Never throws. */
async function resolveShieldBlockForHit(combat, attacker, target, damageRoll) {
  if (!target?.getFlag?.(MODULE_ID, "agentControlled")) return false;
  try {
    const options = collectDefensiveReactionOptions(combat, target, attacker, "damageIncoming", {
      incomingDamage: Number(damageRoll?.total ?? 0),
    });
    if (!options.length) return false;
    const ran = await resolveReactions(
      combat,
      { trigger: "damageIncoming", mover: attacker, options },
      (chosen, decision) => executeShieldBlock(combat, chosen, attacker, decision),
    );
    return ran.some((r) => r.result?.shieldBlock);
  } catch (err) {
    console.error(`${MODULE_ID} | #931: Shield Block check failed:`, err?.message ?? err);
    return false;
  }
}

/**
 * Executes every current Reactive Strike opportunity against `mover` — the
 * single entry point every trigger (ranged-attack chat message,
 * agent-controlled Stride, GM manual check) calls into, so reaction
 * economy, weapon restrictions, and the chat announcement stay identical
 * regardless of what provoked the reaction.
 */
export async function offerReactiveStrikesAgainst(combat, mover, { trigger = "manual", path = null } = {}) {
  // #931: now a pass over the reaction registry for `trigger` -- the
  // GM's manual check (default: Reactive Strike/AoO and Twisting Tail), a
  // ranged Strike (`rangedAttack`: Reactive Strike only), an AI Stride's end
  // (`strideEnd`: Reactive Strike only, #202's own end-of-move check), or a
  // player's move (`move`, with its path).
  await resolveStrikeReactions(combat, mover, { trigger, path });
}

/**
 * #202: reacts to a real ranged-Strike attack-roll chat message by offering
 * every eligible agent-controlled reactor a Reactive Strike against the
 * attacker, via `offerReactiveStrikesAgainst` — shared with #13's
 * agent-Stride and manual-check triggers.
 *
 * Fires globally regardless of whose turn it is (the whole point of a
 * reaction), including a player character's own ranged attack against an
 * agent-controlled monster within its reach. GM-gated (only the GM's own
 * client should ever mutate combat state from a global hook like this) and
 * scoped to this module's own managed combats (`isModuleCombat`). Registered
 * against `createChatMessage` in module.mjs.
 */
export async function handleRangedAttackForReactiveStrike(message) {
  if (!game.user.isGM) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "attack-roll") return;
  if (!context.options?.includes("ranged")) return;

  const sceneId = message.speaker?.scene;
  const attackerTokenId = message.speaker?.token;
  if (!sceneId || !attackerTokenId) return;
  const combat = game.combats.contents.find(
    (c) => c.scene?.id === sceneId && isModuleCombat(c),
  );
  if (!combat) return;
  const attacker = combat.combatants.find((c) => c.tokenId === attackerTokenId);
  if (!attacker || attacker.isDefeated) return;

  await offerReactiveStrikesAgainst(combat, attacker, { trigger: "rangedAttack" });
}

/**
 * #976: the attack-roll chat message a manual Strike's damage-roll
 * `damageMessage` was rolled from -- the nearest earlier
 * `context.type === "attack-roll"` message from the same speaker token and
 * the same weapon (`flags.pf2e.origin.uuid`), accepted only when its own
 * stored target and outcome also match the damage roll's. Scans back from
 * the damage message's own position (not blindly `.at(-1)`), since other
 * messages (riders, reminders, other combatants' rolls) can land in
 * between. Returns `null` when no such message is found or the nearest one
 * disagrees -- callers treat that as "natural face unknown", which draws
 * no card.
 */
export function findAttackMessageForDamage(damageMessage) {
  const all = game.messages?.contents ?? [];
  const context = damageMessage?.flags?.pf2e?.context;
  const tokenId = damageMessage?.speaker?.token;
  if (!context || !tokenId) return null;
  const originUuid = damageMessage.flags?.pf2e?.origin?.uuid ?? null;
  const ownIndex =
    damageMessage.id != null
      ? all.findIndex((m) => m?.id === damageMessage.id)
      : -1;
  const start = (ownIndex >= 0 ? ownIndex : all.length) - 1;
  for (let i = start; i >= 0; i--) {
    const candidate = all[i];
    const candidateContext = candidate?.flags?.pf2e?.context;
    if (candidateContext?.type !== "attack-roll") continue;
    if (candidate.speaker?.token !== tokenId) continue;
    if (
      originUuid &&
      candidate.flags?.pf2e?.origin?.uuid !== originUuid
    )
      continue;
    const targetMatches =
      !context.target?.token ||
      candidateContext.target?.token === context.target.token;
    return targetMatches && candidateContext.outcome === context.outcome
      ? candidate
      : null;
  }
  return null;
}

/**
 * #47: a human party member's manual Strike still goes through PF2e's own
 * roll -> chat card "Apply Damage" button, which resolves its recipient
 * from live `game.user.targets`/selection state — reproduced live as a
 * Fighter's damage roll correctly recording its target
 * (`flags.pf2e.context.target`) while the manual Apply click applied
 * damage to the Fighter's own actor instead. `rollAndApplyStrike` already
 * avoids this for NPC/agent-controlled strikes by never using the manual
 * button at all; this closes the same gap for a human's own strike by
 * reading the roll's own already-correct stored target instead of live
 * selection state, then applying damage itself — same
 * `applyDamage`/`applyDefeatIfReducedToZero` shape `rollAndApplyStrike`
 * already uses.
 *
 * Only acts for a combatant `isExcludedFromAutoPlay` already excludes from
 * this module's own auto-play (a human party member or a manually-added,
 * player-summoned ally) — every other combatant's damage is already
 * applied programmatically by `rollAndApplyStrike`/`rollAndApplyStrikeAtVariant`,
 * and letting this hook act on those too would double-apply the same hit.
 * GM-gated and scoped to this module's own managed combats, matching
 * `handleRangedAttackForReactiveStrike` immediately above. Registered
 * against `createChatMessage` in module.mjs.
 */
export async function handleManualStrikeDamage(message) {
  if (!game.user.isGM) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "damage-roll") return;
  // "damage-roll" also covers spell/cantrip damage, not just Strikes — PF2e
  // tags a Strike's own roll options with "item:type:weapon" or
  // "item:type:melee" (never for a spell's damage roll), the same
  // roll-options-tag idiom `handleRangedAttackForReactiveStrike` above
  // already uses for "ranged". Scopes this hook to Strikes only, matching
  // its name and this issue's own request.
  if (
    !context.options?.includes("item:type:weapon") &&
    !context.options?.includes("item:type:melee")
  )
    return;
  if (message.flags?.pf2e?.appliedDamage) return;

  const sceneId = message.speaker?.scene;
  const attackerTokenId = message.speaker?.token;
  if (!sceneId || !attackerTokenId) return;
  const combat = game.combats.contents.find(
    (c) => c.scene?.id === sceneId && isModuleCombat(c),
  );
  if (!combat) return;
  const attacker = combat.combatants.find((c) => c.tokenId === attackerTokenId);
  if (!attacker || attacker.isDefeated) return;
  if (!isExcludedFromAutoPlay(attacker, partyActorIds())) return;

  // A target's UUID is always `...Scene.<id>.Token.<id>` for a live combat
  // token (linked or unlinked actor alike) — the trailing segment is the
  // token document's own id, the same id `Combatant#tokenId` carries.
  const targetTokenUuid = context.target?.token;
  if (!targetTokenUuid) return;
  const targetTokenId = targetTokenUuid.split(".").pop();
  const target = combat.combatants.find((c) => c.tokenId === targetTokenId);
  if (!target) return;

  const damageRoll = message.rolls?.[0];
  if (!damageRoll) return;

  // #931: an AC-bonus reaction already turned this Strike's hit into a miss,
  // or its GM-confirm card is still open -- skip, or hold the damage until
  // the GM answers it.
  const attackMessage = safeFindAttackMessage(message);
  if (attackMessage?.id) {
    const inFlight = attackReactionsInFlight.get(attackMessage.id);
    if (inFlight) await inFlight;
    const misses = combat.getFlag(MODULE_ID, "reactionAttackMisses") ?? {};
    if (misses[attackMessage.id]) return;
    const pendingId = findPendingReactionId(
      combat,
      (p) => p.attackMessageId === attackMessage.id && p.status === "pending",
    );
    if (pendingId) {
      await updatePendingReaction(combat, pendingId, { damageMessageId: message.id });
      return;
    }
  }
  await continueManualStrikeDamage(combat, message, attacker, target);
}

/** #931: `findAttackMessageForDamage`, never throwing. */
function safeFindAttackMessage(message) {
  try {
    return findAttackMessageForDamage(message);
  } catch {
    return null;
  }
}

/** #931: the rest of a player Strike's damage step -- Shield Block (which
 * may itself wait for a GM-confirm card), then the damage application. */
async function continueManualStrikeDamage(combat, message, attacker, target) {
  const shieldBlock = await resolvePlayerShieldBlock(combat, message, attacker, target);
  if (shieldBlock === "deferred") return;
  await applyManualStrikeDamage(combat, message, attacker, target, {
    shieldBlock: shieldBlock === "block",
  });
}

/** #47 (split out by #931): applies a human's manual Strike damage roll to
 * its stored target, then the critical-deck card and the applied marker. */
async function applyManualStrikeDamage(combat, message, attacker, target, { shieldBlock = false } = {}) {
  const context = message.flags?.pf2e?.context ?? {};
  const damageRoll = message.rolls?.[0];
  if (!damageRoll || !target?.actor) return;
  await target.actor.applyDamage({
    damage: damageRoll,
    token: target.token,
    outcome: context.outcome,
    ...(shieldBlock ? { shieldBlockRequest: true } : {}),
  });
  await applyDefeatIfReducedToZero(target);

  // #92: a player's own manual Strike goes through this hook instead of
  // rollAndApplyStrike, which already draws a Critical Hit/Fumble Deck card
  // on criticalSuccess/criticalFailure via drawCriticalCardForStrike --
  // this closes that same gap here. Unlike rollAndApplyStrike, this hook
  // never rolled the Strike itself, so it has no live `strike` action
  // object to hand drawCriticalCardForStrike. Read both functions: the only
  // field either of them ever reads off `strike` is `strike.item` (the
  // weapon), so `message.item` -- PF2e's own ChatMessagePF2e getter,
  // resolving straight to the live weapon Item off the attacker's actor via
  // the message's own stored origin flag, not a stale clone -- is exactly
  // enough to rebuild a strike-shaped `{ item }` and the `soundContext`
  // shape (`damageType`/`isRanged`) drawCriticalCardForStrike needs,
  // mirroring strikeSoundContext's own damageType derivation above. A
  // missing/unresolvable item is a soft no-op, matching this module's
  // existing "a missing compendium/item shouldn't break combat resolution"
  // philosophy (see drawAndApplyCriticalCard's own doc comment).
  if (
    context.outcome === "criticalSuccess" ||
    context.outcome === "criticalFailure"
  ) {
    const weaponItem = message.item ?? null;
    if (weaponItem) {
      const strike = { item: weaponItem };
      const damageRolls = Object.values(weaponItem.system?.damageRolls ?? {});
      const soundContext = {
        isRanged: !!weaponItem.isRanged,
        damageType:
          weaponItem.system?.damage?.damageType ??
          damageRolls[0]?.damageType ??
          null,
      };
      // #976: the damage message carries no natural-die info of its own
      // (confirmed live -- no `check:total:natural:*` option, no d20), so
      // the natural face comes from the matching attack-roll message.
      await drawCriticalCardForStrike(
        context.outcome,
        strike,
        soundContext,
        attacker,
        target,
        naturalD20(findAttackMessageForDamage(message)?.rolls?.[0]),
      );
    }
  }

  // Marks the source message resolved so PF2e's own chat-card Apply Damage
  // button (still rendered — this hook never replaces the card) shows as
  // already-applied instead of staying live, which is exactly the double
  // -application this hook's own appliedDamage guard above expects to be
  // able to detect on a later duplicate message.
  await message.update({
    "flags.pf2e.appliedDamage": { uuid: target.actor.uuid },
  });
}

/** #931: attack-roll message ids whose reaction check is still running, so
 * the paired damage roll waits for it instead of racing it. */
const attackReactionsInFlight = new Map();

/** #931: whether `combat` belongs to a hosted GM-less run (no human GM --
 * the relay's always-connected Agent account is a GM user, so the user list
 * cannot tell). Unreadable run state reads as "a GM is present". */
function isGmLessCombat(combat) {
  try {
    return isGmLessRunState(getRunState(combat.scene?.id));
  } catch {
    return false;
  }
}

function findPendingReactionId(combat, predicate) {
  const pending = combat.getFlag(MODULE_ID, "pendingReactions") ?? {};
  return Object.keys(pending).find((id) => predicate(pending[id])) ?? null;
}

async function updatePendingReaction(combat, confirmId, changes) {
  const pending = combat.getFlag(MODULE_ID, "pendingReactions") ?? {};
  if (!pending[confirmId]) return;
  await combat.setFlag(MODULE_ID, "pendingReactions", {
    ...pending,
    [confirmId]: { ...pending[confirmId], ...changes },
  });
}

/**
 * #931: the one-click GM-confirm card for a defensive reaction against a
 * player's Strike at a table with a human GM (never in GM-less mode, see
 * `defensiveReactionMode`). Records what the click needs (ids and the
 * trigger's numbers -- never live documents) under
 * `flags.pf2e-dungeon-crawl.pendingReactions` on the combat; the damage of
 * that Strike waits for the answer. Returns `{ confirmPending: true }`.
 */
async function postReactionConfirmCard(combat, chosen, attacker, decision, { attackMessageId = null, damageMessageId = null } = {}) {
  const { reactor, def, ctx } = chosen;
  const confirmId = foundry.utils.randomID();
  await updatePendingReactionMap(combat, confirmId, {
    kind: def.kind,
    defId: def.id,
    reactorId: reactor.id,
    attackerId: attacker?.id ?? null,
    attackMessageId,
    damageMessageId,
    round: combat.round,
    status: "pending",
    ctx: {
      rollTotal: ctx.rollTotal ?? null,
      dcValue: ctx.dcValue ?? null,
      natural: ctx.natural ?? null,
      outcome: ctx.outcome ?? null,
      incomingDamage: ctx.incomingDamage ?? null,
      shieldHardness: ctx.shieldHardness ?? null,
      shieldName: ctx.shieldName ?? null,
    },
  });
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const effect =
    def.kind === "acBonus"
      ? `+${def.acBonus} circumstance bonus to AC turns the hit (${ctx.rollTotal} vs AC ${ctx.dcValue}) into a miss. Its damage waits for your answer.`
      : `block ${ctx.incomingDamage} damage with ${ctx.shieldName} (Hardness ${ctx.shieldHardness}). The damage waits for your answer.`;
  const content =
    game.i18n.format("PF2EDC.Dungeon.Combat.ReactionConfirmCard", {
      name: esc(reactor.name),
      reaction: esc(def.label),
      attacker: esc(attacker?.name ?? "the attacker"),
      effect: esc(effect),
    }) +
    `<div class="pf2edc-reaction-confirm">` +
    `<button type="button" data-pf2edc-reaction="accept">${esc(game.i18n.format("PF2EDC.Dungeon.Combat.ReactionConfirmUse", { reaction: def.label }))}</button>` +
    `<button type="button" data-pf2edc-reaction="decline">${esc(game.i18n.localize("PF2EDC.Dungeon.Combat.ReactionConfirmDecline"))}</button>` +
    `</div>` +
    reactionGmNoteHtml(reactionDecisionNote(decision));
  await ChatMessage.create({
    content,
    whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    flags: { [MODULE_ID]: { reactionConfirm: { combatId: combat.id, confirmId } } },
  });
  return { confirmPending: true, confirmId };
}

async function updatePendingReactionMap(combat, confirmId, record) {
  const pending = combat.getFlag(MODULE_ID, "pendingReactions") ?? {};
  await combat.setFlag(MODULE_ID, "pendingReactions", { ...pending, [confirmId]: record });
}

/**
 * #931: Shield Block against a player's Strike damage -- `"block"` (used
 * automatically: GM-less run), `"deferred"` (a GM-confirm card holds the
 * damage) or `"none"`. Never throws.
 */
async function resolvePlayerShieldBlock(combat, message, attacker, target) {
  try {
    const options = collectDefensiveReactionOptions(combat, target, attacker, "damageIncoming", {
      incomingDamage: Number(message.rolls?.[0]?.total ?? 0),
    });
    if (!options.length) return "none";
    const mode = defensiveReactionMode({ attackerIsPlayerDriven: true, gmLess: isGmLessCombat(combat) });
    const ran = await resolveReactions(
      combat,
      { trigger: "damageIncoming", mover: attacker, options },
      (chosen, decision) =>
        mode === "automatic"
          ? executeShieldBlock(combat, chosen, attacker, decision)
          : postReactionConfirmCard(combat, chosen, attacker, decision, { damageMessageId: message.id }),
    );
    if (ran.some((r) => r.result?.confirmPending)) return "deferred";
    return ran.some((r) => r.result?.shieldBlock) ? "block" : "none";
  } catch (err) {
    console.error(`${MODULE_ID} | #931: Shield Block check failed:`, err?.message ?? err);
    return "none";
  }
}

/**
 * #931: an AC-bonus reaction (Wing Deflection, Ghost Dodge, Swat
 * Projectile) against a human player's Strike on an agent-controlled
 * creature. The system rolled and posted the attack, so this runs after it
 * resolved (spec): when the reaction's bonus would turn the hit into a miss
 * the reaction is used -- automatically with no human GM (a hosted GM-less
 * run), through a one-click GM-confirm card when a human GM runs the table
 * -- and the paired damage roll is skipped (`handleManualStrikeDamage`).
 * AI attackers' own Strikes resolve this inline in `rollAndApplyStrike*`.
 * Active GM only; registered against `createChatMessage` in module.mjs.
 */
export async function handleAttackRollForReactions(message) {
  if (!(game.users?.activeGM?.isSelf ?? game.user?.isGM)) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "attack-roll" || context.action !== "strike") return;
  if (!isHitOutcome(context.outcome)) return;
  const sceneId = message.speaker?.scene;
  const attackerTokenId = message.speaker?.token;
  const targetTokenId = context.target?.token?.split(".").pop();
  if (!sceneId || !attackerTokenId || !targetTokenId) return;
  const combat = game.combats.contents.find((c) => c.scene?.id === sceneId && isModuleCombat(c));
  if (!combat) return;
  const attacker = combat.combatants.find((c) => c.tokenId === attackerTokenId);
  const target = combat.combatants.find((c) => c.tokenId === targetTokenId);
  if (!attacker || attacker.isDefeated || !target) return;
  if (!isExcludedFromAutoPlay(attacker, partyActorIds())) return;

  const work = (async () => {
    const options = collectDefensiveReactionOptions(
      combat,
      target,
      attacker,
      "targetedByAttack",
      attackReactionContext(message, context.outcome),
    );
    if (!options.length) return;
    const mode = defensiveReactionMode({ attackerIsPlayerDriven: true, gmLess: isGmLessCombat(combat) });
    await resolveReactions(combat, { trigger: "targetedByAttack", mover: attacker, options }, (chosen, decision) =>
      mode === "automatic"
        ? executeAcBonusReaction(combat, chosen, attacker, decision, { attackMessageId: message.id })
        : postReactionConfirmCard(combat, chosen, attacker, decision, { attackMessageId: message.id }),
    );
  })().catch((err) =>
    console.error(`${MODULE_ID} | #931: attack-roll reaction check failed:`, err?.message ?? err),
  );
  if (message.id) attackReactionsInFlight.set(message.id, work);
  try {
    await work;
  } finally {
    if (message.id) attackReactionsInFlight.delete(message.id);
  }
}

/**
 * #931: the GM's answer to a reaction confirm card (`accept` true = use the
 * reaction). Re-resolves every document fresh by id; a card answered after
 * its round ended, or after the reactor already spent its reaction or left
 * the fight, is treated as declined. Using an AC-bonus reaction records the
 * miss (the held damage is dropped); Shield Block applies the held damage
 * with `shieldBlockRequest`; declining applies the held damage normally
 * (after an AC-bonus decline, Shield Block is still checked). Marks the card
 * resolved. Returns `"used"`, `"declined"`, or null when there was nothing
 * to answer.
 */
export async function answerReactionConfirm(combatId, confirmId, accept, { cardMessage = null } = {}) {
  if (!game.user.isGM) return null;
  const combat = game.combats?.get?.(combatId) ?? game.combats?.contents?.find((c) => c.id === combatId);
  if (!combat) return null;
  const pending = (combat.getFlag(MODULE_ID, "pendingReactions") ?? {})[confirmId];
  if (!pending || pending.status !== "pending") return null;
  const def = reactionDefById(pending.defId);
  const reactor = combatantById(combat, pending.reactorId);
  const attacker = pending.attackerId ? combatantById(combat, pending.attackerId) : null;
  let use = !!accept && !!def;
  let reason = use ? null : "declined by the GM";
  if (use && combat.round !== pending.round) {
    use = false;
    reason = "the round it was triggered in has ended";
  } else if (use && (!reactor || reactor.isDefeated)) {
    use = false;
    reason = "the reacting creature is no longer in the fight";
  } else if (use && getReactionUsed(combat, reactor.id, combat.round)) {
    use = false;
    reason = "it already used its reaction this round";
  }
  await updatePendingReaction(combat, confirmId, { status: use ? "used" : "declined" });

  const damageMessage = pending.damageMessageId ? game.messages?.get?.(pending.damageMessageId) : null;
  const chosen = { reactor, def, ctx: { ...pending.ctx } };
  const gmDecision = { source: "gm", rationale: null };
  try {
    if (def?.kind === "acBonus") {
      if (use) {
        await executeAcBonusReaction(combat, chosen, attacker, gmDecision, { attackMessageId: pending.attackMessageId });
      } else if (damageMessage && attacker && reactor) {
        await continueManualStrikeDamage(combat, damageMessage, attacker, reactor);
      }
    } else if (def?.kind === "damageReduction") {
      if (use) await executeShieldBlock(combat, chosen, attacker, gmDecision);
      if (damageMessage && attacker && reactor) {
        await applyManualStrikeDamage(combat, damageMessage, attacker, reactor, { shieldBlock: use });
      }
    }
  } finally {
    if (cardMessage) {
      const resolvedText = use ? `${def?.label ?? "Reaction"} used.` : `No reaction (${reason}).`;
      const content =
        String(cardMessage.content ?? "").replace(/<div class="pf2edc-reaction-confirm">[\s\S]*?<\/div>/, "") +
        game.i18n.format("PF2EDC.Dungeon.Combat.ReactionConfirmResolved", { result: resolvedText });
      await cardMessage.update({ content, [`flags.${MODULE_ID}.reactionConfirm.resolved`]: true });
    }
  }
  return use ? "used" : "declined";
}

/** #931: a dragged/keyboard move's path as one position per square --
 * origin first, then every square entered along each waypoint segment. */
function expandMovementPath(points, gridSize) {
  const cells = [];
  const push = (gx, gy, w, h) => {
    const last = cells.at(-1);
    if (last && last.gx === gx && last.gy === gy) return;
    cells.push({ gx, gy, w, h });
  };
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const gx = Math.round(p.x / gridSize);
    const gy = Math.round(p.y / gridSize);
    if (i === 0) {
      push(gx, gy, p.width, p.height);
      continue;
    }
    const from = cells.at(-1);
    const n = Math.max(Math.abs(gx - from.gx), Math.abs(gy - from.gy));
    for (let k = 1; k <= n; k++) {
      push(
        from.gx + Math.round(((gx - from.gx) * k) / n),
        from.gy + Math.round(((gy - from.gy) * k) / n),
        p.width,
        p.height,
      );
    }
  }
  return cells.map((c) => ({ x: c.gx * gridSize, y: c.gy * gridSize, width: c.w ?? 1, height: c.h ?? 1 }));
}

/**
 * #931: a human player's own token move during its turn in a module combat
 * fires the move-triggered NPC reactions (Reactive Strike / Attack of
 * Opportunity, Twisting Tail, Wing Rebuff) automatically, in both modes
 * (spec: movement reactions stay automatic with a GM present, as #202's
 * were). Reads Foundry v14's `moveToken` hook movement (origin + the
 * waypoints passed), only for a player's own dragging/keyboard move -- the
 * module's own displace moves (AI walks, pushes, resnaps) and pastes/undos
 * never count. The reactions resolve after the fact (the token already
 * moved), each at the square it fired on. A move of a single square is
 * treated as a Step, which triggers none of these (Player Core: Step
 * doesn't trigger reactions that move actions or leaving a square would).
 * A disrupted move (Twisting Tail hit) ends where the reaction fired: in a
 * GM-less run the token is moved back there; with a GM present the GM gets
 * a note to adjudicate. Active GM only; registered in module.mjs.
 */
export async function handleTokenMoveForReactions(tokenDoc, movement) {
  if (!(game.users?.activeGM?.isSelf ?? game.user?.isGM)) return;
  try {
    if (!["dragging", "keyboard"].includes(movement?.method)) return;
    const waypoints = movement.passed?.waypoints ?? [];
    if (!waypoints.length || !movement.origin) return;
    if (waypoints.some((w) => w?.action === "displace" || w?.action === "blink")) return;
    const scene = tokenDoc?.parent;
    const combat = game.combats?.contents?.find(
      (c) => c.scene?.id === scene?.id && isModuleCombat(c) && (c.started ?? c.round > 0),
    );
    if (!combat) return;
    const mover = combat.combatants.find((c) => c.tokenId === tokenDoc.id);
    if (!mover || mover.isDefeated) return;
    if (mover.getFlag(MODULE_ID, "agentControlled")) return;
    if (combat.combatant?.id !== mover.id) return;
    const gridSize = scene.grid?.size ?? 100;
    const path = expandMovementPath([movement.origin, ...waypoints], gridSize);
    if (path.length <= 2) return;
    const ran = await resolveStrikeReactions(combat, mover, { trigger: "move", path });
    const disrupting = ran.find((r) => r.result?.disrupted);
    if (!disrupting || mover.isDefeated) return;
    await postMoveDisruptedNote(mover, disrupting);
    const point = disrupting.ctx.point;
    // Wing Rebuff's push already moved the token; only a Twisting Tail-style
    // disruption leaves it standing past the square the reaction hit it on.
    if (disrupting.def.disrupts !== "hit" || !point) return;
    if (isGmLessCombat(combat)) {
      await tokenDoc.move({ x: point.x, y: point.y, action: "displace" });
    } else {
      const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
      await whisperGmContent(
        game.i18n.format("PF2EDC.Dungeon.Combat.ReactionDisruptedMoveGm", {
          name: esc(disrupting.reactor.name),
          reaction: esc(disrupting.def.label),
          target: esc(mover.name),
          x: Math.round(point.x / gridSize),
          y: Math.round(point.y / gridSize),
        }),
      );
    }
  } catch (err) {
    console.error(`${MODULE_ID} | #931: move reaction check failed:`, err?.message ?? err);
  }
}

/**
 * The real Foundry-computed set of opponents caught by a cone template
 * aimed at each of `rawOpponents` in turn (one placement option per
 * opponent, matching #119's per-opponent burst placements) — confirmed
 * live this is exact containment, not the Chebyshev-square approximation
 * #119 itself uses (see #150, filed to bring #119 in line with this).
 * Creates every candidate template in one batch, computes each one's
 * shape, reads containment, then deletes all of them — the scene must be
 * the currently *viewed* one for `_computeShape()` to populate `.shape`,
 * the same constraint #120's `rollAttack` has for its own reason. Caller
 * is responsible for the scene already being viewed (or accepting that
 * this returns empty placements if it isn't).
 */
/** A token's true geometric center in pixels — `token.x`/`token.y` is
 * always its top-left corner, and `token.width`/`token.height` (in grid
 * squares, not pixels) is 1 for a Medium creature but larger for
 * Large/Huge/Gargantuan ones (confirmed live: an adult dragon's own token
 * is 3×3). Assuming a fixed one-square offset silently miscenters the cone
 * origin — and every candidate aim-direction computed from it — for any
 * non-Medium creature, exactly the size class most breath-weapon-bearing
 * creatures fall into. */
function tokenCenter(token, gridSize) {
  return {
    x: token.x + ((token.width ?? 1) * gridSize) / 2,
    y: token.y + ((token.height ?? 1) * gridSize) / 2,
  };
}

async function computeConePlacements(
  combat,
  casterToken,
  rawOpponents,
  distanceFeet,
  rawAllies = [],
) {
  const scene = combat.scene;
  if (!scene || game.scenes.viewed?.id !== scene.id) return [];
  const gridSize = scene.grid?.size ?? 100;
  const origin = tokenCenter(casterToken, gridSize);

  const templateData = rawOpponents.map((aim) => {
    const aimCenter = tokenCenter(aim.token, gridSize);
    const direction =
      (Math.atan2(aimCenter.y - origin.y, aimCenter.x - origin.x) * 180) /
      Math.PI;
    return {
      t: "cone",
      x: origin.x,
      y: origin.y,
      direction,
      angle: 90,
      distance: distanceFeet,
      hidden: true,
    };
  });
  if (!templateData.length) return [];

  const created = await scene.createEmbeddedDocuments(
    "MeasuredTemplate",
    templateData,
  );
  try {
    return created.map((templateDoc, i) => {
      const canvasObject = canvas.templates?.get(templateDoc.id);
      if (
        canvasObject &&
        !canvasObject.shape &&
        typeof canvasObject._computeShape === "function"
      ) {
        canvasObject.shape = canvasObject._computeShape();
      }
      const shape = canvasObject?.shape ?? null;
      const contained = (pool) =>
        shape
          ? pool
              .filter((o) => {
                const center = tokenCenter(o.token, gridSize);
                return shape.contains(center.x - origin.x, center.y - origin.y);
              })
              .map((o) => ({ id: o.id, name: o.name }))
          : [];
      // #915: allies too, for an NPC ability that affects every creature.
      return {
        centerType: "opponent",
        centerId: rawOpponents[i].id,
        affected: contained(rawOpponents),
        affectedAllies: contained(rawAllies),
      };
    });
  } finally {
    await scene.deleteEmbeddedDocuments(
      "MeasuredTemplate",
      created.map((t) => t.id),
    );
  }
}

/**
 * The real Foundry-computed set of opponents/allies caught by a circular
 * burst/emanation template centered at each of `centers` in turn — the
 * same exact-containment approach `computeConePlacements` already uses for
 * breath-weapon cones, replacing the Chebyshev-square approximation (a
 * burst/emanation's circle vs. its bounding square, whose far diagonal
 * corners a real circle wouldn't reach) #119/#140/#176 all used before
 * (see #150). `centers` carries each candidate placement's own
 * `centerType`/`centerId` (matching the caller's existing placement
 * shape) alongside the real `originToken` to center the template on —
 * `combatant.token` for an emanation's single self-centered placement,
 * each opponent's own token for a burst's per-opponent placements. Same
 * viewed-scene requirement and batch-create/compute/read/delete pattern as
 * `computeConePlacements` — see that function's own comment for why.
 */
async function computeAreaPlacements(
  combat,
  centers,
  rawOpponents,
  rawAllies,
  radiusFeet,
) {
  const scene = combat.scene;
  if (!scene || game.scenes.viewed?.id !== scene.id || !centers.length)
    return [];
  const gridSize = scene.grid?.size ?? 100;

  const templateData = centers.map((center) => {
    const origin = tokenCenter(center.originToken, gridSize);
    return {
      t: "circle",
      x: origin.x,
      y: origin.y,
      distance: radiusFeet,
      hidden: true,
    };
  });

  const created = await scene.createEmbeddedDocuments(
    "MeasuredTemplate",
    templateData,
  );
  try {
    return created.map((templateDoc, i) => {
      const canvasObject = canvas.templates?.get(templateDoc.id);
      if (
        canvasObject &&
        !canvasObject.shape &&
        typeof canvasObject._computeShape === "function"
      ) {
        canvasObject.shape = canvasObject._computeShape();
      }
      const shape = canvasObject?.shape ?? null;
      const origin = tokenCenter(centers[i].originToken, gridSize);
      const contained = (pool) =>
        shape
          ? pool
              .filter((o) => {
                const center = tokenCenter(o.token, gridSize);
                return shape.contains(center.x - origin.x, center.y - origin.y);
              })
              .map((o) => ({ id: o.id, name: o.name }))
          : [];
      return {
        centerType: centers[i].centerType,
        centerId: centers[i].centerId,
        affected: contained(rawOpponents),
        affectedAllies: contained(rawAllies),
      };
    });
  } finally {
    await scene.deleteEmbeddedDocuments(
      "MeasuredTemplate",
      created.map((t) => t.id),
    );
  }
}

/**
 * The raw stored `agentTurnState` flag, but only when it actually belongs to
 * this exact turn — same `combatantId` *and* the same `round`/`turn` the
 * Combat is on right now. `combatantId` alone isn't enough: the same
 * combatant returns to this same check on every one of its future turns, so
 * comparing only `combatantId` can't tell "still mid-turn" from "this
 * combatant's turn again, next round" — which is exactly what left a lone
 * agent-controlled NPC permanently passive from round 2 onward (its
 * exhausted `actionsRemaining: 0` from the previous round kept matching).
 * Returns `null` whenever the stored flag doesn't match, so callers fall
 * back to a fresh state.
 */
function currentStoredAgentTurnState(combat, combatantId) {
  const stored = combat.getFlag(MODULE_ID, "agentTurnState");
  if (
    stored?.combatantId === combatantId &&
    stored.round === combat.round &&
    stored.turn === combat.turn
  )
    return stored;
  return null;
}

const MELEE_MANEUVER_SLUGS = ["trip", "shove", "grapple", "disarm"];

/**
 * #909: whether `actor` can satisfy a melee maneuver's free-hand
 * requirement — either a literal free hand (`handsFree`, confirmed
 * present only on CharacterPF2e actors in the installed system — not
 * NPCs) or a currently-held weapon carrying `slug` as one of its own
 * traits (PF2e's own "or a weapon with the matching trait" exception,
 * e.g. a trip-trait weapon for Trip). An actor with no `handsFree` getter
 * at all (every NPC) defaults to eligible, matching
 * dungeon-strike-riders.mjs's resolveAthleticsRider precedent of gating
 * NPC maneuvers on skill existence alone, never hand state.
 */
function hasFreeHandOrManeuverWeapon(actor, slug) {
  if (typeof actor?.handsFree === "number" && actor.handsFree > 0) return true;
  const heldWeapons = (actor?.itemTypes?.weapon ?? []).filter(
    (w) => w.system?.equipped?.carryType === "held",
  );
  if (heldWeapons.some((w) => (w.system?.traits?.value ?? []).includes(slug))) return true;
  return actor?.handsFree === undefined;
}

/** #909: this turn's real maneuver eligibility for `actor`, in the plain
 * shape agent-candidates.mjs's buildManeuverVocabulary expects —
 * everything Foundry-specific (skill existence, free hand/weapon trait)
 * is resolved here; that file never touches a real actor document. */
export function computeManeuverAttackerProfile(actor) {
  const profile = {};
  const hasAthletics = !!actor?.skills?.athletics;
  const hasIntimidation = !!actor?.skills?.intimidation;
  // #911: feat-driven size-cap widening (Titan Wrestler) and skill
  // substitution (Sly Disarm) from the curated maneuver-feat table.
  const modifiers = eligibilityModifiers(actorFeatSlugs(actor), {
    athleticsRank: actor?.skills?.athletics?.rank,
    athleticsMod: actor?.skills?.athletics?.mod,
    thieveryMod: actor?.skills?.thievery?.mod,
  });
  for (const slug of MELEE_MANEUVER_SLUGS) {
    profile[slug] = {
      eligible: hasAthletics && hasFreeHandOrManeuverWeapon(actor, slug),
      reachSquares: AGENT_MELEE_REACH_SQUARES,
      skill: modifiers.skill[slug] ?? MANEUVER_DEFS[slug].skill,
      sizeCapSteps: modifiers.sizeCapSteps[slug] ?? 1,
    };
  }
  // #910: Rage -- "You can't use actions with the concentrate trait unless
  // they also have the rage trait"; Demoralize is concentrate, not rage.
  const raging = (actor?.itemTypes?.effect ?? []).some((e) => e?.slug === "effect-rage");
  profile.demoralize = {
    eligible: hasIntimidation && !raging,
    reachSquares: DEMORALIZE_RANGE_SQUARES,
    skill: MANEUVER_DEFS.demoralize.skill,
    sizeCapSteps: 1,
  };
  return profile;
}

/** #911: the slugs of `actor`'s own feat items (the maneuver-feat table's
 * input). Unreadable item data yields no slugs -- base RAW, never more
 * permissive. */
function actorFeatSlugs(actor) {
  try {
    return Array.from(actor?.items ?? [])
      .filter((i) => i?.type === "feat" && typeof i.slug === "string")
      .map((i) => i.slug);
  } catch {
    return [];
  }
}

/** #909: PF2e's own "target no more than one size larger than you"
 * prerequisite, shared verbatim by Trip/Shove/Grapple/Disarm (confirmed
 * in each action's own lang/action-en.json text). `capSteps` widens it
 * (#911: Titan Wrestler, 2 or 3). Unreadable size data on either side
 * defaults to allowed rather than blocking the maneuver on a data gap. */
export function sizeOkForManeuver(attackerActor, targetActor, capSteps = 1) {
  const attackerIdx = SIZE_ORDER.indexOf(attackerActor?.system?.traits?.size?.value);
  const targetIdx = SIZE_ORDER.indexOf(targetActor?.system?.traits?.size?.value);
  if (attackerIdx < 0 || targetIdx < 0) return true;
  return targetIdx - attackerIdx <= capSteps;
}

/** #909: Demoralize's own 10-minute re-attempt immunity (PF2e RAW: "the
 * target is temporarily immune to your attempts to Demoralize it for 10
 * minutes", regardless of outcome) — tracked as a real worldTime
 * timestamp (reusing #785's game clock) rather than a round count, scoped
 * to this Combat document the same way agentTurnState already is. Returns
 * 0 (never immune) when nothing has been recorded yet for this pair. */
export function getDemoralizeImmunityUntil(combat, attackerId, targetId) {
  return combat.getFlag(MODULE_ID, "demoralizeImmunity")?.[attackerId]?.[targetId] ?? 0;
}

export async function setDemoralizeImmunityUntil(combat, attackerId, targetId, worldTimeExpiry) {
  const current = combat.getFlag(MODULE_ID, "demoralizeImmunity") ?? {};
  await combat.setFlag(MODULE_ID, "demoralizeImmunity", {
    ...current,
    [attackerId]: { ...(current[attackerId] ?? {}), [targetId]: worldTimeExpiry },
  });
}

/** #909: Demoralize carries the emotion, fear and mental traits (the
 * installed system's own `demoralize` action definition), so a target
 * immune to any of those (e.g. a mindless undead's mental immunity) can
 * never be affected by it -- excluded from the vocabulary rather than
 * offered as a wasted action. */
const DEMORALIZE_BLOCKING_IMMUNITIES = new Set(["mental", "emotion", "fear-effects"]);

/** #909: Disarm "knock[s] an item out of a creature's grasp" -- a target
 * holding nothing (e.g. an NPC with only natural attacks) can't be
 * Disarmed. Unreadable item data counts as holding nothing. */
export function holdsAnItem(actor) {
  return Array.from(actor?.items ?? []).some(
    (i) => i?.system?.equipped?.carryType === "held",
  );
}

export function immuneToDemoralize(targetActor) {
  return (targetActor?.attributes?.immunities ?? []).some((i) =>
    DEMORALIZE_BLOCKING_IMMUNITIES.has(i?.type),
  );
}

/** #914: at most this many self-effect entries are sent per turn (spec
 * Decision 5), most tactically relevant first. */
const SELF_EFFECT_VOCABULARY_CAP = 12;

/** #914/#946: the deterministic checks against a linked effect's OWN rule
 * elements/duration that decide whether this module can apply it to an AI
 * actor unattended. True (unsafe) on any hit: an unresolved ChoiceSet (the
 * system would open a choice dialog), GrantItem (granted items this module
 * doesn't track or clean up), no rules at all (nothing to apply), an
 * hours/days duration (outlives the encounter by design), or a target
 * dependence classifyTargetEffect calls `marked` (needs a chosen creature --
 * the targetedSelfEffect kind, #922/#946) or `unsupported`. #946: a
 * `targetConditional` effect (only `target:` roll-option predicates, which
 * the system tests against each roll's own target -- Point Blank Stance,
 * Spell Parry) is safe; #914's old blanket target: rule wrongly excluded
 * it. The classified live compendium population is
 * tests/fixtures/self-effect-audit-snapshot.json. */
function isUnsafeSelfEffect(rules, duration, classification = classifyTargetEffect(rules)) {
  if (rules.length === 0) return true;
  if (duration?.unit === "hours" || duration?.unit === "days") return true;
  if (classification === "marked" || classification === "unsupported") return true;
  return rules.some((r) => r?.key === "ChoiceSet" || r?.key === "GrantItem");
}

/** #934: the NPC counterpart of isUnsafeSelfEffect, for monster abilities
 * (npc-self-parse.mjs). Same exclusions, refined both ways:
 *  - a `GrantItem` is allowed in exactly one shape: `inMemoryOnly` and
 *    pointing at a `conditionitems` entry (Thesis Shield's Concealed) -- a
 *    condition that exists only while the effect does, nothing to track.
 *    Every other GrantItem stays excluded for #914's reason.
 *  - a sustained effect (needs a Sustain action every turn) is excluded.
 *  - an `unlimited` duration is excluded unless the ability is a stance: a
 *    monster's unlimited effect ends on a prose condition the effect doesn't
 *    model (Harden Chitin "until they next take a move action", Death Gasp),
 *    whereas a stance lasts until the encounter ends -- which
 *    cleanupAgentSelfEffects enforces. */
function isUnsafeSelfEffectForNpc(rules, duration, { stance = false } = {}) {
  if (rules.length === 0) return true;
  if (duration?.unit === "hours" || duration?.unit === "days") return true;
  if (duration?.sustained) return true;
  if (duration?.unit === "unlimited" && !stance) return true;
  return rules.some((r) => {
    if (r?.key === "GrantItem") {
      return !(r.inMemoryOnly === true && /^Compendium\.pf2e\.conditionitems\./.test(r.uuid ?? ""));
    }
    if (r?.key === "ChoiceSet" || r?.key === "TokenMark") return true;
    const text = JSON.stringify(r);
    return text.includes("target:") || /@target\b/.test(text);
  });
}

export const __test__isUnsafeSelfEffectForNpc = isUnsafeSelfEffectForNpc;

/** #914: PF2e `frequency.per` values (ISO-8601 durations or plain units)
 * as words the reasoning model can read. Unknown values pass through. */
const FREQUENCY_PER_LABELS = {
  PT1M: "minute",
  PT10M: "10 minutes",
  PT1H: "hour",
  PT24H: "day",
  P1W: "week",
  P1M: "month",
};

function selfEffectFrequencyLabel(frequency) {
  if (!frequency) return null;
  const per = frequency.per ?? "day";
  return `${frequency.max ?? 1}/${FREQUENCY_PER_LABELS[per] ?? per}`;
}

/** #910: traits that keep an activatable item out of the turn-time
 * vocabulary (not usable in an encounter turn). */
const FEAT_EXCLUDED_TRAITS = new Set(["exploration", "downtime"]);

/** #910: the action traits that gate per-turn reuse, carried on vocabulary
 * entries so agent-candidates.mjs can enforce PF2e's one-flourish-per-turn
 * and one-stance-action-per-round rules. */
const FEAT_TURN_GATING_TRAITS = ["flourish", "stance", "finisher"];

function featGatingTraits(item) {
  const traits = item.system?.traits?.value ?? [];
  return FEAT_TURN_GATING_TRAITS.filter((t) => traits.includes(t));
}

/** #910: an action/free-action item's real cost, or null for anything else
 * (passive, reaction, unreadable). */
function featActionCost(item) {
  const actionType = item.system?.actionType?.value;
  if (actionType === "free") return 0;
  if (actionType !== "action") return null;
  const cost = item.system?.actions?.value;
  return typeof cost === "number" && cost > 0 ? cost : null;
}

/** #910: a PF2e `ChoiceSet` rule still unresolved on this item (no
 * selection recorded under its flag) -- such an item is excluded; this
 * module never invents a choice for an AI actor's own feat. */
function hasUnresolvedChoiceSet(item) {
  const rules = item.system?.rules ?? [];
  return rules.some(
    (r) =>
      r?.key === "ChoiceSet" &&
      typeof r.flag === "string" &&
      item.flags?.pf2e?.rulesSelections?.[r.flag] === undefined,
  );
}

/** #910: whether `actor` already has the effect `item` would apply --
 * either an effect created from this very item (PF2e's own self-effect
 * handler writes `system.context.origin.item` = the action's uuid) or the
 * same linked effect from any other source (same slug), so a buff is never
 * re-offered while active (Rage: "you aren't ... raging"). */
function actorAlreadyHasEffectFrom(actor, item, effectSlug) {
  return (actor.itemTypes?.effect ?? []).some(
    (e) =>
      e.system?.context?.origin?.item === item.uuid ||
      (effectSlug && e.slug === effectSlug),
  );
}

/** #910: the id of an active stance effect on `actor`, or null. An effect
 * is a stance when it carries the stance trait itself (the system copies
 * the action's effect-valid traits onto it) or its origin item does. PF2e
 * RAW: entering a stance ends any stance you're already in. */
async function findActiveStanceEffectId(actor) {
  for (const effect of actor.itemTypes?.effect ?? []) {
    if ((effect.system?.traits?.value ?? []).includes("stance")) return effect.id;
    const originItemUuid = effect.system?.context?.origin?.item;
    if (!originItemUuid) continue;
    const originItem = await fromUuid(originItemUuid);
    if (originItem?.system?.traits?.value?.includes("stance")) return effect.id;
  }
  return null;
}

function actorHasCondition(actor, slug) {
  return Array.from(actor?.conditions ?? []).some((c) => c.slug === slug);
}

/** #910/#914: the self-effect vocabulary category, on character actors only
 * (NPC abilities are #915). #914 replaced #910's stances+Rage allowlist with
 * a derived filter: any one-action/free item with a resolvable selfEffect,
 * kept by #910's per-turn gates (excluded traits, cost, frequency, the
 * item's own unresolved ChoiceSet, Rage's Fatigued requirement, already
 * active), the linked effect's own safety checks (isUnsafeSelfEffect) and
 * the reviewed SELF_EFFECT_DENYLIST. Scans both itemTypes.action and
 * itemTypes.feat (the system's own self-effect marker lives on both).
 * Returns plain `{itemId, slug, name, cost, replacesStance, traits,
 * effectSummary, durationLabel, frequencyLabel}` entries for
 * agent-candidates.mjs's buildFeatVocabulary, sorted by relevance tier
 * (stable, so ties keep item order) and capped. Any item whose data can't
 * be read is excluded, never defaulted to available. */
export async function computeSelfEffectVocabularyEntries(actor, actionsRemaining) {
  if (actor?.type !== "character") return [];
  const scored = [];
  const items = [...(actor.itemTypes?.action ?? []), ...(actor.itemTypes?.feat ?? [])];
  for (const item of items) {
    try {
      const selfEffect = item.system?.selfEffect;
      if (!selfEffect?.uuid) continue;
      const traits = item.system?.traits?.value ?? [];
      const isStance = traits.includes("stance");
      if (SELF_EFFECT_DENYLIST.has(item.slug)) continue;
      if (traits.some((t) => FEAT_EXCLUDED_TRAITS.has(t))) continue;
      const cost = featActionCost(item);
      if (cost === null || cost > actionsRemaining) continue;
      const frequencyValue = item.system?.frequency?.value;
      if (item.system?.frequency && !(frequencyValue > 0)) continue;
      if (hasUnresolvedChoiceSet(item)) continue;
      // Rage's own requirement: "You aren't Fatigued or raging."
      if (item.slug === "rage" && actorHasCondition(actor, "fatigued")) continue;
      const effect = await fromUuid(selfEffect.uuid);
      if (!effect) continue;
      const rules = effect.system?.rules ?? [];
      const duration = effect.system?.duration;
      const targetDependence = classifyTargetEffect(rules);
      if (isUnsafeSelfEffect(rules, duration, targetDependence)) continue;
      // #946: the target-conditional effects #914 used to exclude are
      // admitted only when their own Requirements hold (Point Blank
      // Stance's ranged weapon, Spell Parry's free hand); a requirement
      // outside the closed set excludes the item.
      if (targetDependence === "targetConditional") {
        const requirements = parseFeatRequirements(item.system?.description?.value);
        if (!requirements || !requirements.every((p) => npcSelfRequirementHolds(p, actor, []))) continue;
      }
      if (actorAlreadyHasEffectFrom(actor, item, effect.slug)) continue;
      const replacesStance = isStance ? await findActiveStanceEffectId(actor) : null;
      scored.push({
        tier: effectRelevanceTier(rules),
        entry: {
          itemId: item.id,
          slug: item.slug,
          name: item.name,
          cost,
          replacesStance,
          traits: featGatingTraits(item),
          effectSummary:
            targetDependence === "targetConditional"
              ? `${summarizeEffect(rules)} (conditional on the roll's target)`
              : summarizeEffect(rules),
          durationLabel: effectDurationLabel(duration),
          frequencyLabel: selfEffectFrequencyLabel(item.system?.frequency),
        },
      });
    } catch (err) {
      console.warn(`#910: skipping unreadable feat item ${item?.name ?? item?.id}:`, err.message);
    }
  }
  scored.sort((a, b) => a.tier - b.tier);
  return scored.slice(0, SELF_EFFECT_VOCABULARY_CAP).map((s) => s.entry);
}

/** #934: an actor's held items (weapons, shields) -- PF2e's own
 * `system.equipped.carryType`. */
function heldItemsOf(actor) {
  return Array.from(actor?.items ?? []).filter((i) => i?.system?.equipped?.carryType === "held");
}

function itemNameIncludes(item, name) {
  return String(item?.name ?? "").toLowerCase().includes(name);
}

/** #934: "under a fear effect" -- a condition/effect carrying the PF2e
 * `fear` trait, or the Frightened condition itself (the fear condition: a
 * creature that is frightened is gripped by fear). */
function underFearEffect(actor) {
  if (actorHasCondition(actor, "frightened")) return true;
  const items = [...Array.from(actor?.conditions ?? []), ...(actor?.itemTypes?.effect ?? [])];
  return items.some((i) => (i?.system?.traits?.value ?? []).includes("fear"));
}

/** #934: one npc-self-parse.mjs requirement predicate against the actor and
 * its detectable opponents (`{actor, distanceFeet}`). Unknown predicate ->
 * false.
 *  - handFree: the hands its held items occupy (`equipped.handsHeld`) leave
 *    one free. Bestiary weapons are carried `worn` with no hands held, so
 *    the system's own state is what's read -- nothing is inferred.
 *  - wielding: a held item of that name, or a Strike (NPC `melee` item) of
 *    that name -- an NPC's Strikes are the weapons its stat block wields.
 *  - wearing: a worn item of that name.
 *  - wieldingRanged (#946): a held ranged weapon.
 * #946: also evaluates a character's own self-effect Requirements
 * (marked-target-requirements.mjs) -- the same closed predicate set. */
function npcSelfRequirementHolds(predicate, actor, opponents) {
  switch (predicate?.type) {
    case "handFree": {
      const hands = heldItemsOf(actor).reduce((n, i) => n + (Number(i.system.equipped.handsHeld) || 0), 0);
      return hands < 2;
    }
    case "wieldingRanged":
      // #946: "You are wielding a ranged weapon" -- a held weapon with a
      // range (WeaponPF2e#isRanged is `!!system.range`).
      return heldItemsOf(actor).some((i) => i?.type === "weapon" && !!i.system?.range);
    case "wielding":
      return (
        heldItemsOf(actor).some((i) => itemNameIncludes(i, predicate.name)) ||
        (actor?.itemTypes?.melee ?? []).some((i) => itemNameIncludes(i, predicate.name))
      );
    case "wearing":
      return Array.from(actor?.items ?? []).some(
        (i) => i?.system?.equipped?.carryType === "worn" && itemNameIncludes(i, predicate.name),
      );
    case "hasCondition":
      return actorHasCondition(actor, predicate.slug);
    case "notHasCondition":
      return !actorHasCondition(actor, predicate.slug);
    case "enemyWithin":
      return opponents.some(
        (o) =>
          o.distanceFeet <= predicate.feet &&
          predicate.conditions.some((c) => (c === "fear-effect" ? underFearEffect(o.actor) : actorHasCondition(o.actor, c))),
      );
    default:
      return false;
  }
}

/** #934: the condition slugs an effect's own `GrantItem` rules grant. */
async function grantedConditionSlugs(rules) {
  const slugs = new Set();
  for (const rule of rules) {
    if (rule?.key !== "GrantItem" || !/^Compendium\.pf2e\.conditionitems\./.test(rule.uuid ?? "")) continue;
    const condition = await fromUuid(rule.uuid);
    if (condition?.slug) slugs.add(condition.slug);
  }
  return slugs;
}

/**
 * #934: the NPC self-buff/self-heal entries (npc-self-parse.mjs) `combatant`
 * can use right now -- the Foundry-touching half of the npcSelf vocabulary.
 * NPC actors only (a character's selfEffect actions are #910/#914's feat
 * vocabulary). Each parsed ability is kept only when: its cost fits,
 * frequency uses remain, it isn't recharging (the shared `abilityRecharge`
 * store); for an effect family, the linked effect resolves, passes
 * isUnsafeSelfEffectForNpc, isn't already active, and grants every
 * condition its prose names; for a heal, the creature is hurt; and every
 * requirement predicate holds against its detectable opponents (PF2e
 * distance). Anything unreadable is excluded, never defaulted to
 * available. Returns plain entries for agent-candidates.mjs's
 * buildNpcSelfVocabulary.
 */
export async function computeNpcSelfEntries(combat, combatant, actionsRemaining) {
  const actor = combatant?.actor;
  if (actor?.type !== "npc") return [];
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  let opponents = null;
  const opponentsInFeet = () =>
    (opponents ??= detectableOpponents(combat, combatant).map((c) => ({
      actor: c.actor,
      distanceFeet: pf2eDistanceFeet(combatant.token, c.token, gridSize, gridDistanceFt),
    })));
  const entries = [];
  for (const item of actorActionItems(actor)) {
    try {
      const descriptor = parseSelfAbility(item);
      if (!descriptor) continue;
      if (descriptor.cost > actionsRemaining) continue;
      const uses = descriptor.frequency?.value;
      if (descriptor.frequency && !(typeof uses === "number" && uses > 0)) continue;
      const slug = actionItemSlug(item);
      if (!isAbilityRecharged(combat, combatant.id, slug)) continue;
      const traits = item.system?.traits?.value ?? [];
      let effectInfo = { effectSummary: null, durationLabel: null, tier: 2 };
      if (descriptor.params.effectUuid) {
        const effect = await fromUuid(descriptor.params.effectUuid);
        if (!effect) continue;
        const rules = effect.system?.rules ?? [];
        const duration = effect.system?.duration;
        if (isUnsafeSelfEffectForNpc(rules, duration, { stance: traits.includes("stance") })) continue;
        if (actorAlreadyHasEffectFrom(actor, item, effect.slug)) continue;
        if (descriptor.conditions.length) {
          const granted = await grantedConditionSlugs(rules);
          if (descriptor.conditions.some((c) => !granted.has(c))) continue;
        }
        effectInfo = {
          effectSummary: summarizeEffect(rules),
          durationLabel: effectDurationLabel(duration),
          tier: effectRelevanceTier(rules),
        };
      }
      let hpFraction = null;
      if (descriptor.family === "selfHeal") {
        const hp = actor.system?.attributes?.hp;
        if (typeof hp?.value !== "number" || !(hp.max > 0) || hp.value >= hp.max) continue;
        hpFraction = hp.value / hp.max;
      }
      const needsOpponents = descriptor.requirements.some((r) => r.type === "enemyWithin");
      const opponentsForCheck = needsOpponents ? opponentsInFeet() : [];
      if (!descriptor.requirements.every((p) => npcSelfRequirementHolds(p, actor, opponentsForCheck))) continue;
      entries.push({
        itemId: item.id,
        slug,
        name: item.name,
        family: descriptor.family,
        cost: descriptor.cost,
        traits: featGatingTraits(item),
        hpFraction,
        tier: effectInfo.tier,
        effectSummary: effectInfo.effectSummary,
        durationLabel: effectInfo.durationLabel,
        frequencyLabel: selfEffectFrequencyLabel(descriptor.frequency),
        summary: describeNpcSelfAbility(descriptor, { hpFraction, ...effectInfo }),
      });
    } catch (err) {
      console.warn(`#934: skipping unreadable NPC action item ${item?.name ?? item?.id}:`, err.message);
    }
  }
  return entries;
}

/** #922: at most this many targeted self-effect entries (one per legal
 * target) are sent per turn, in opponent order -- the same order the Strike
 * candidates use. */
const TARGETED_SELF_EFFECT_VOCABULARY_CAP = 12;

/** #922: whether `actor` has a ready Strike Devise a Stratagem's attack
 * stratagem can apply to -- the effect's own SubstituteRoll predicate: an
 * agile or finesse weapon, or a ranged one that isn't thrown. Without one
 * the stored d20 can never replace a Strike roll. */
function hasStratagemStrike(actor) {
  return (actor?.system?.actions ?? []).some((a) => {
    if (a.type !== "strike" || a.ready === false) return false;
    const traits = a.item?.system?.traits?.value ?? [];
    if (traits.includes("agile") || traits.includes("finesse")) return true;
    return !isMeleeStrikeAction(a) && !traits.some((t) => String(t).startsWith("thrown"));
  });
}

/** #922/#946: the targeted self-effect vocabulary category (character
 * actors only, like #910/#914's self-effects): every action/feat item with
 * a linked self-effect that resolveTargetedSelfEffectConfig accepts --
 * #922's Hunt Prey / Devise a Stratagem, plus #946's derived marked-target
 * items (Smite, Duelist's Challenge, Size Up) -- kept by #910's per-turn
 * gates (excluded traits, cost, frequency, unresolved ChoiceSet), whose
 * linked effect really carries the bindable TokenMark rule, and whose own
 * Requirements hold (the closed #934/#946 predicate set). One entry per
 * legal target. `opponents` are `{id, name, hasLineOfSight, tokenUuid,
 * distanceFeet, actor}` for the opponents this actor can currently target
 * (stealth matrix already applied). The system ignores TokenMark on an
 * actor with no token on the viewed canvas, so such an actor gets no
 * entries. A concentrate action isn't offered while raging. Per target:
 * "you can see" needs line of sight, "within N feet" the PF2e distance,
 * "non-mindless" a target without the mindless trait, and "see and hear" an
 * actor that isn't deafened. A mark that moves on re-use (Hunt Prey, Smite,
 * Size Up) is never offered against the creature it already marks; any
 * other (Devise a Stratagem, Duelist's Challenge) isn't offered while its
 * mark is active. Devise a Stratagem also needs a Strike its d20 can apply
 * to. Returns plain `{itemId, slug, name, cost, targetId, traits,
 * effectSummary}` entries for buildFeatVocabulary. */
export async function computeTargetedSelfEffectVocabularyEntries(actor, opponents, actionsRemaining) {
  if (actor?.type !== "character") return [];
  if (typeof actor.getActiveTokens !== "function" || actor.getActiveTokens().length === 0) return [];
  const entries = [];
  const items = [...(actor.itemTypes?.action ?? []), ...(actor.itemTypes?.feat ?? [])];
  const effects = actor.itemTypes?.effect ?? [];
  // Rage: "You can't use actions with the concentrate trait unless they also
  // have the rage trait".
  const raging = effects.some((e) => e?.slug === "effect-rage");
  for (const item of items) {
    try {
      const uuid = item?.system?.selfEffect?.uuid;
      if (!uuid) continue;
      const traits = item.system?.traits?.value ?? [];
      if (traits.some((t) => FEAT_EXCLUDED_TRAITS.has(t))) continue;
      if (raging && traits.includes("concentrate") && !traits.includes("rage")) continue;
      const cost = featActionCost(item);
      if (cost === null || cost > actionsRemaining) continue;
      if (item.system?.frequency && !(item.system.frequency.value > 0)) continue;
      if (hasUnresolvedChoiceSet(item)) continue;
      const effect = await fromUuid(uuid);
      if (typeof effect?.toObject !== "function") continue;
      const source = effect.toObject();
      const config = resolveTargetedSelfEffectConfig(item, source);
      if (!config) continue;
      if (!bindTokenMarkEffect(source, config.markSlug, "probe")) continue;
      if (!config.requirements.every((p) => npcSelfRequirementHolds(p, actor, opponents ?? []))) continue;
      if (config.needsHearing && actorHasCondition(actor, "deafened")) continue;
      const marked = markedTokenUuids(effects, config.markSlug);
      if (!config.exclusiveMark && marked.length > 0) continue;
      if (item.slug === "devise-a-stratagem" && !hasStratagemStrike(actor)) continue;
      const durationLabel = effectDurationLabel(source.system?.duration);
      for (const o of opponents ?? []) {
        if (!o.tokenUuid) continue;
        if (config.requiresSight && o.hasLineOfSight === false) continue;
        if (config.rangeFeet != null && !(o.distanceFeet <= config.rangeFeet)) continue;
        if (config.targetNotMindless && (o.actor?.system?.traits?.value ?? []).includes("mindless")) continue;
        if (config.exclusiveMark && marked.includes(o.tokenUuid)) continue;
        entries.push({
          itemId: item.id,
          slug: item.slug,
          name: item.name,
          cost,
          targetId: o.id,
          traits: featGatingTraits(item),
          effectSummary:
            item.slug === "hunt-prey"
              ? `mark prey: +bonuses vs ${o.name}`
              : item.slug === "devise-a-stratagem"
                ? `d20 replaces next Strike vs ${o.name}`
                : summarizeMarkEffect(source.system?.rules, config.markSlug, o.name, durationLabel),
        });
      }
    } catch (err) {
      console.warn(`#922: skipping unreadable targeted action ${item?.name ?? item?.id}:`, err.message);
    }
  }
  return entries.slice(0, TARGETED_SELF_EFFECT_VOCABULARY_CAP);
}

/** #947: at most this many targeted-action entries per turn. */
const TARGETED_ACTION_VOCABULARY_CAP = 12;

/** #947: the system's own finisher toggle on a finisher feat -- a
 * toggleable `RollOption` for `finisher` with the feat's suboption
 * (Unbalancing Finisher: `finisher:unbalancing`), which switches Precise
 * Strike's finisher dice and the feat's own Note on for the Strike. Null
 * when the item has none (its finisher damage couldn't be rolled). */
function finisherRollOption(item) {
  const rule = (item?.system?.rules ?? []).find(
    (r) => r?.key === "RollOption" && r.option === "finisher" && r.toggleable && Array.isArray(r.suboptions),
  );
  const suboption = rule?.suboptions?.[0]?.value;
  return typeof suboption === "string" && suboption ? { suboption } : null;
}

/** #947: whether ready strike `action` may make a `strikePlus` feat's
 * Strike: a melee Strike when the feat says "melee Strike"; Resounding
 * Blow's "wielding a melee weapon that deals bludgeoning damage" -- a held
 * melee weapon (not an unarmed attack) whose damage type is that one; and a
 * finisher's "weapons that deal additional damage with precise strike" --
 * an agile or finesse melee attack (Precise Strike's own predicate). */
function targetedStrikeActionAllowed(action, descriptor) {
  if (action?.type !== "strike" || action.ready === false) return false;
  if (descriptor.params.melee && !isMeleeStrikeAction(action)) return false;
  const weapon = descriptor.requirements?.weapon;
  if (weapon) {
    if (!isMeleeStrikeAction(action) || !isMeleeWeaponStrike(action)) return false;
    if (action.item?.system?.equipped?.carryType !== "held") return false;
    if (action.item?.system?.damage?.damageType !== weapon.damageType) return false;
  }
  if ((descriptor.traits ?? []).includes("finisher")) {
    if (!isMeleeStrikeAction(action)) return false;
    const traits = action.item?.system?.traits?.value ?? [];
    if (!traits.includes("agile") && !traits.includes("finesse")) return false;
  }
  return true;
}

/** #947: the best ready strike (highest attack modifier) `descriptor` may
 * use against a target `distanceSquares` away, or null. */
function targetedStrikeActionFor(actor, descriptor, distanceSquares, gridDistanceFt) {
  const usable = (actor?.system?.actions ?? []).filter(
    (a) =>
      targetedStrikeActionAllowed(a, descriptor) &&
      distanceSquares <= actionReachSquares(a, gridDistanceFt) + REACH_EPSILON,
  );
  usable.sort((a, b) => (b.totalModifier ?? 0) - (a.totalModifier ?? 0));
  return usable[0] ?? null;
}

/** #947: the turn-level gates a parsed targeted feat must pass before any
 * target is considered: cost, frequency, the action traits' own rules
 * (rage: only while raging, and a raging actor can't use a concentrate
 * action without the rage trait; finisher: only with panache, never after a
 * finisher this turn, and only with the system's finisher toggle to roll it;
 * press: only while a multiple attack penalty applies), and a `targetEffect`
 * needs an active token for its TokenMark. Flourish/stance are
 * buildFeatVocabulary's own gates. */
function targetedActionUsable(actor, item, descriptor, turnState) {
  if (descriptor.cost > (turnState?.actionsRemaining ?? 0)) return false;
  if (item.system?.frequency && !(item.system.frequency.value > 0)) return false;
  if (hasUnresolvedChoiceSet(item)) return false;
  const traits = descriptor.traits ?? [];
  const raging = (actor.itemTypes?.effect ?? []).some((e) => e?.slug === "effect-rage");
  if (traits.includes("rage") && !raging) return false;
  if (raging && traits.includes("concentrate") && !traits.includes("rage")) return false;
  if (traits.includes("finisher")) {
    if (turnState?.finisherUsed || !actorHasPanache(actor) || !finisherRollOption(item)) return false;
  }
  if (traits.includes("press") && !((turnState?.mapIncrement ?? 0) > 0)) return false;
  if (descriptor.shape === "targetEffect") {
    if (typeof actor.getActiveTokens !== "function" || actor.getActiveTokens().length === 0) return false;
  }
  return true;
}

/** #947: the sense a `targetEffect` with a visual-or-auditory trait choice
 * uses against `targetActor` -- visual unless it's blinded, else auditory
 * unless it's deafened; null when it can perceive neither. */
function senseTraitAgainst(targetActor) {
  if (!actorHasCondition(targetActor, "blinded")) return "visual";
  if (!actorHasCondition(targetActor, "deafened")) return "auditory";
  return null;
}

/** #947: this actor's active agent-created targetEffect marks from `item`,
 * by marked token uuid. */
function targetEffectMarkedTokens(actor, item) {
  return (actor.itemTypes?.effect ?? [])
    .filter((e) => e?.flags?.[MODULE_ID]?.targetedActionItemId === item.id)
    .map((e) => e.flags[MODULE_ID].markTargetTokenUuid)
    .filter(Boolean);
}

/** #947: the targeted-action vocabulary (character actors only): every
 * action/feat item feat-action-shapes.mjs recognizes (Intimidating Strike,
 * Vicious Evisceration, Resounding Blow, Unbalancing Finisher, Instant
 * Opening in pf2e 8.5.0), kept by targetedActionUsable's turn gates, one
 * entry per legal target:
 *  - strikePlus: an opponent in line of sight within reach of a ready
 *    strike the feat allows (targetedStrikeActionAllowed);
 *  - targetEffect: an opponent within the feat's range that can perceive
 *    the distraction (senseTraitAgainst) and isn't already marked by it.
 * `opponents` are `{id, name, hasLineOfSight, distanceSquares,
 * distanceFeet, tokenUuid, actor}` (stealth matrix already applied).
 * Returns plain `{itemId, slug, name, cost, targetId, traits, attack,
 * effectSummary}` entries for buildFeatVocabulary. */
export function computeTargetedActionVocabularyEntries(actor, opponents, turnState, gridDistanceFt = 5) {
  if (actor?.type !== "character") return [];
  const entries = [];
  const items = [...(actor.itemTypes?.action ?? []), ...(actor.itemTypes?.feat ?? [])];
  for (const item of items) {
    try {
      const descriptor = parseTargetedFeat(item);
      if (!descriptor) continue;
      if (!targetedActionUsable(actor, item, descriptor, turnState)) continue;
      const marked = descriptor.shape === "targetEffect" ? targetEffectMarkedTokens(actor, item) : [];
      for (const o of opponents ?? []) {
        if (descriptor.shape === "strikePlus") {
          if (o.hasLineOfSight === false) continue;
          if (!targetedStrikeActionFor(actor, descriptor, o.distanceSquares, gridDistanceFt)) continue;
        } else {
          if (!o.tokenUuid || marked.includes(o.tokenUuid)) continue;
          if (!(o.distanceFeet <= descriptor.params.rangeFeet)) continue;
          if (descriptor.params.senseChoice && !senseTraitAgainst(o.actor)) continue;
        }
        entries.push({
          itemId: item.id,
          slug: item.slug,
          name: item.name,
          cost: descriptor.cost,
          targetId: o.id,
          traits: featGatingTraits(item),
          attack: descriptor.shape === "strikePlus",
          effectSummary: summarizeTargetedFeat(descriptor, o.name),
        });
      }
    } catch (err) {
      console.warn(`#947: skipping unreadable targeted action ${item?.name ?? item?.id}:`, err.message);
    }
  }
  return entries.slice(0, TARGETED_ACTION_VOCABULARY_CAP);
}

/** #910: whether a strike action is a melee one -- the same "finite
 * positive range increment means ranged" rule actionReachSquares uses
 * (number on PC weapons, `{increment}` on NPC items). */
function isMeleeStrikeAction(action) {
  const range = action?.item?.system?.range;
  const increment = typeof range === "number" ? range : range?.increment;
  if (Number.isFinite(increment) && increment > 0) return false;
  return !(action?.item?.system?.traits?.value ?? []).some((t) =>
    String(t).startsWith("range-increment"),
  );
}

function readyMeleeStrikeActions(actor) {
  return (actor?.system?.actions ?? []).filter(
    (a) => a.type === "strike" && a.ready !== false && isMeleeStrikeAction(a),
  );
}

/** #910: Lunge's "You are wielding a melee weapon" -- a real weapon item,
 * not an unarmed attack. */
function isMeleeWeaponStrike(action) {
  return action.item?.type === "weapon" && action.item?.system?.category !== "unarmed";
}

/** #910: Twin Feint's "two melee weapons, each in a different hand": two
 * distinct held weapon items each wielded in exactly one hand (so,
 * necessarily, different hands). Returns the two strike actions, or null. */
function twinFeintStrikePair(actor) {
  const byItem = new Map();
  for (const a of readyMeleeStrikeActions(actor)) {
    if (!isMeleeWeaponStrike(a)) continue;
    const equipped = a.item?.system?.equipped;
    if (equipped?.carryType !== "held" || equipped?.handsHeld !== 1) continue;
    if (!byItem.has(a.item.id)) byItem.set(a.item.id, a);
  }
  const pair = [...byItem.values()].slice(0, 2);
  return pair.length === 2 ? pair : null;
}

/** #910: Lunge's strike for a target `distanceSquares` away -- the first
 * melee weapon strike whose reach falls exactly 5 ft short of it. */
function lungeStrikeFor(actor, distanceSquares, gridDistanceFt) {
  const extra = 5 / gridDistanceFt;
  return (
    readyMeleeStrikeActions(actor).find((a) => {
      if (!isMeleeWeaponStrike(a)) return false;
      const reach = actionReachSquares(a, gridDistanceFt);
      return distanceSquares > reach + REACH_EPSILON && distanceSquares <= reach + extra + REACH_EPSILON;
    }) ?? null
  );
}

const COMPOSITE_FEAT_SLUGS = new Set(["sudden-charge", "lunge", "twin-feint"]);

/** #910: the curated composite-feat allowlist's own eligibility -- each
 * feat's real PF2e requirement (installed system text) checked against the
 * actor's ready strikes; character actors only. `opponents` is the
 * serialized `{id, distanceSquares, hasLineOfSight}` list
 * getPendingAgentTurn already builds.
 *  - Lunge: wielding a melee weapon; target just beyond its reach.
 *  - Sudden Charge: any melee Strike; target out of reach now but within
 *    reach after two Strides.
 *  - Twin Feint: two one-handed melee weapons; target in reach of both. */
export function computeCompositeVocabularyEntries(actor, opponents, actionsRemaining, gridDistanceFt = 5) {
  if (actor?.type !== "character") return [];
  const entries = [];
  const feats = (actor.itemTypes?.feat ?? []).filter((f) => COMPOSITE_FEAT_SLUGS.has(f.slug));
  const meleeActions = readyMeleeStrikeActions(actor);
  const visible = (opponents ?? []).filter((o) => o.hasLineOfSight !== false);

  for (const feat of feats) {
    const cost = featActionCost(feat);
    if (cost === null || cost > actionsRemaining) continue;
    if (feat.system?.frequency && !(feat.system.frequency.value > 0)) continue;
    const base = { itemId: feat.id, slug: feat.slug, name: feat.name, cost, traits: featGatingTraits(feat) };

    if (feat.slug === "lunge") {
      for (const o of visible) {
        if (lungeStrikeFor(actor, o.distanceSquares, gridDistanceFt)) entries.push({ ...base, targetId: o.id });
      }
    } else if (feat.slug === "sudden-charge") {
      if (meleeActions.length === 0) continue;
      const maxReach = Math.max(...meleeActions.map((a) => actionReachSquares(a, gridDistanceFt)));
      const speedFt = actor.system?.movement?.speeds?.land?.value ?? 0;
      const twoStridesSquares = 2 * Math.floor(speedFt / gridDistanceFt);
      for (const o of visible) {
        if (o.distanceSquares > maxReach + REACH_EPSILON && o.distanceSquares - maxReach <= twoStridesSquares + REACH_EPSILON) {
          entries.push({ ...base, targetId: o.id });
        }
      }
    } else if (feat.slug === "twin-feint") {
      const pair = twinFeintStrikePair(actor);
      if (!pair) continue;
      const reach = Math.min(...pair.map((a) => actionReachSquares(a, gridDistanceFt)));
      for (const o of visible) {
        if (o.distanceSquares <= reach + REACH_EPSILON) entries.push({ ...base, targetId: o.id });
      }
    }
  }
  return entries;
}

/** Reads back Combat's own per-turn agent bookkeeping, or a fresh one
 * (`initAgentTurnState()`) if this is the first decision seen for this exact
 * combatant/round/turn — see `currentStoredAgentTurnState` above. */
function getAgentTurnState(combat, combatantId) {
  const stored = currentStoredAgentTurnState(combat, combatantId);
  return stored
    ? {
        actionsRemaining: stored.actionsRemaining,
        mapIncrement: stored.mapIncrement,
        maneuverPicks: stored.maneuverPicks ?? null,
        flourishUsed: stored.flourishUsed ?? false,
        stanceUsed: stored.stanceUsed ?? false,
        finisherUsed: stored.finisherUsed ?? false,
      }
    : initAgentTurnState();
}

/** Writes the per-turn state back, tagged with the combat's current
 * `round`/`turn` (so a later turn can never mistake this for "still
 * current," see `currentStoredAgentTurnState`) and a `counter` that
 * increments on every write for this same turn. `armAgentTimeout` captures
 * that counter at arm time and re-checks it before firing its fallback, so
 * a timer superseded by a real decision already applied can tell it's stale
 * instead of firing on top of a turn that's still being played. */
async function setAgentTurnState(combat, combatantId, turnState) {
  const counter =
    (currentStoredAgentTurnState(combat, combatantId)?.counter ?? 0) + 1;
  await combat.setFlag(MODULE_ID, "agentTurnState", {
    combatantId,
    round: combat.round,
    turn: combat.turn,
    actionsRemaining: turnState.actionsRemaining,
    mapIncrement: turnState.mapIncrement,
    maneuverPicks: turnState.maneuverPicks ?? null,
    flourishUsed: turnState.flourishUsed ?? false,
    stanceUsed: turnState.stanceUsed ?? false,
    finisherUsed: turnState.finisherUsed ?? false,
    counter,
  });
}

/** The closest opposing combatant, or null if none remain. */
function nearestOpponent(combat, combatant) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const me = combatant.token;
  let best = null;
  let bestDistance = Infinity;
  for (const opponent of combatantTargets(combat, combatant)) {
    const distance = chebyshevSquares(me, opponent.token, gridSize);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = opponent;
    }
  }
  return best ? { combatant: best, distanceSquares: bestDistance } : null;
}

const MELEE_REACH_SQUARES = 1;

/** Grid-square {gx, gy} for a token's position. Tokens here are always
 * exactly grid-aligned (one square), same "pixel / gridSize, no center
 * offset" convention chebyshevSquares already uses. */
function tokenCell(token, gridSize) {
  return {
    gx: Math.round(token.x / gridSize),
    gy: Math.round(token.y / gridSize),
  };
}

/** Corrects `token`'s own stored position to its nearest grid cell if it
 * isn't already exactly grid-aligned -- #86: a token can end up off-grid
 * (visibly straddling four grid squares) for reasons entirely outside this
 * module's own movement math, e.g. a manual, unsnapped drag in Foundry's own
 * UI. Every mover function below has at least one early-return path
 * (already in range, no speed, no path, no valid waypoint) that only ever
 * *reads* the mover/target's current position to decide whether to act, and
 * previously left that position completely untouched otherwise -- silently
 * preserving a pre-existing off-grid position for the rest of that
 * combatant's turns, since nothing else in this module ever re-validates a
 * token it isn't actively moving. Called unconditionally, before any of
 * those early returns can fire, so a bad existing position gets corrected
 * even on a turn that otherwise wouldn't move the token at all. A no-op (no
 * `move` call) when the token is already aligned -- overwhelmingly the
 * common case -- so this never adds a second write alongside a real move's
 * own single write. */
async function snapTokenToGrid(token, gridSize) {
  const cell = tokenCell(token, gridSize);
  const snappedX = cell.gx * gridSize;
  const snappedY = cell.gy * gridSize;
  if (token.x !== snappedX || token.y !== snappedY) {
    // #141: Foundry v14 runs every TokenDocument#update({x,y}) through its own
    // movement pipeline, which re-checks wall collisions on the straight-line
    // path even for a scripted update -- if that line clips a wall, Foundry
    // silently substitutes a quarter-cell "collision waypoint" instead of the
    // exact cell requested. This module already does its own wall-aware
    // pathfinding before ever calling update(), so that check is redundant
    // and is the actual mechanism putting tokens off-grid. Foundry's
    // `displace` movement action (walls: null) bypasses it -- same fix as
    // dungeon-follow.mjs's #87/PR #407, ported here for combat movement's
    // own four call sites. #631: originally passed the deprecated update
    // option { teleport: true } (which maps to `displace`); now
    // token.move({ action: "displace" }), whose per-call action does not
    // persist movementAction on the document.
    await token.move({ x: snappedX, y: snappedY, action: "displace" });
  }
}

/** {gx0, gy0, gx1, gy1} bounding every grid square the scene actually
 * covers, so findPath's search space stays finite even on this generator's
 * deliberately over-provisioned canvas (ITEM-20). Null (unbounded search) if
 * the scene has no usable dimensions yet. */
function sceneBounds(combat, gridSize) {
  const width = combat.scene?.width;
  const height = combat.scene?.height;
  if (!width || !height) return null;
  return {
    gx0: 0,
    gy0: 0,
    gx1: Math.ceil(width / gridSize) - 1,
    gy1: Math.ceil(height / gridSize) - 1,
  };
}

// wallBlocksMovement (shared, pathfinding.mjs, #884): a wall blocks movement
// if its own `move` sense says so, unless it's a door currently standing
// open — this generator's doors transition CLOSED/LOCKED -> OPEN when a
// player opens one (handleDungeonDoorOpened, dungeon-scene.mjs), so a party
// that's already opened a door shouldn't find it treated as a wall.

/** The isBlocked(a, b) predicate for this combat's real scene walls alone
 * (no combatant-occupancy blocking) — the shared wall-lookup both
 * `movementBlockedEdges` (movement, below) and `hasLineOfSight` (#91,
 * ranged/spell target eligibility) build on, so a wall/door blocks both the
 * same way from one single source of wall data. */
function sceneWallBlockedEdges(combat) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const walls = (combat.scene?.walls?.contents ?? [])
    .filter(wallBlocksMovement)
    .map((w) => ({ x1: w.c[0], y1: w.c[1], x2: w.c[2], y2: w.c[3] }));
  return blockedEdgesFromWalls(walls, gridSize);
}

/** The isBlocked(a, b) predicate pathfinding.mjs's findPath expects, built
 * from this combat's real scene walls, plus — #27 — every hostile
 * combatant's own occupied square: a Stride must never pass through an
 * enemy's space, any more than it can pass through a wall. `excludeCell`,
 * if given, is dropped from the hostile-block list (see
 * `hostileFootprints`'s own docblock for why that's needed). */
function movementBlockedEdges(combat, combatant, excludeCell = null) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const wallBlocked = sceneWallBlockedEdges(combat);
  const hostiles = hostileFootprints(combat, combatant, gridSize, excludeCell);
  // #567: living cover is never subject to the excludeCell exemption.
  const cover = livingCoverFootprints(combat, gridSize);
  return (a, b) =>
    wallBlocked(a, b) || cellOccupied(b, hostiles) || cellOccupied(b, cover);
}

/**
 * Whether `attackerToken` has a clear, wall-unobstructed straight line to
 * `targetToken` — #91: ranged Strikes and ranged/area spells were
 * targetable purely by grid distance, with no wall/door check at all, so a
 * target in an entirely different room (behind a solid wall) could be hit.
 * Grid/edge-based rather than Foundry's own canvas vision primitives
 * (`canvas.walls`, `canvas.effects.visibility`) deliberately: those depend
 * on a live, rendered canvas, which isn't guaranteed to exist on whichever
 * client executes a relay-driven, GM-less agent turn (no human necessarily
 * looking at that scene) — the same reasoning pathfinding.mjs's own
 * docblock already gives for why movement pathing here is
 * Foundry-canvas-decoupled, not just Scene-document-decoupled. Reuses
 * `sceneWallBlockedEdges`'s own wall-lookup, so a wall or door blocks a
 * shot exactly the same way it already blocks movement, including
 * `wallBlocksMovement`'s existing open-door exception (an open door, reveal
 * door or otherwise, never blocks — the module's own
 * `dungeonRevealDoorForSlot`/`dungeonDoorToSlot` flags are irrelevant to
 * this, same as they already are for movement, since `wallBlocksMovement`
 * only ever consults the native `door`/`ds` fields).
 */
export function hasLineOfSight(combat, attackerToken, targetToken) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const isBlocked = sceneWallBlockedEdges(combat);
  const start = tokenCell(attackerToken, gridSize);
  const goal = tokenCell(targetToken, gridSize);
  return sightLineClear(start, goal, isBlocked);
}

/** Footprints (placement.mjs's {gx,gy,gw,gh} shape) of every hostile
 * combatant relative to `combatant` — #27: a Stride must never pass
 * through an enemy's space. `excludeCell`, if given, drops any hostile
 * whose own footprint sits exactly there — the specific square a Stride
 * is approaching (an opponent's own square) would otherwise become
 * permanently unreachable to findPath, even though walkPath's own
 * landing check (see otherCombatantFootprints below) already guarantees the
 * mover never actually ends up standing there. */
function hostileFootprints(combat, combatant, gridSize, excludeCell = null) {
  return combatantOpponents(combat, combatant)
    .map((c) => footprint(c.token, gridSize))
    .filter(
      (f) =>
        !(excludeCell && f.gx === excludeCell.gx && f.gy === excludeCell.gy),
    );
}

/** Footprints of every living cover item (#567) plus every OTHER
 * still-alive combatant (i.e. excluding
 * `combatant` itself), ally or hostile, relative to `combatant` — #27: a
 * Stride may never end its movement sharing a square with anyone, even an
 * ally (PF2e disallows it without an explicit exception this module
 * doesn't model). Passing THROUGH an ally's square is still fine; only
 * walkPath's landing choice consults this list, never findPath's
 * edge-blocking (which only cares about hostiles, via hostileFootprints
 * above). */
function otherCombatantFootprints(combat, combatant, gridSize) {
  return [
    ...[
      ...combatantOpponents(combat, combatant),
      ...combatantAllies(combat, combatant),
    ].map((c) => footprint(c.token, gridSize)),
    // #567: a mover also never ends on a living cover item (non-combatant).
    ...livingCoverFootprints(combat, gridSize),
  ];
}

/** Whether the mover's own `moverFootprint.gw × moverFootprint.gh` block,
 * anchored top-left at `cell`, overlaps any footprint in `footprints` — the
 * shared occupancy check `movementBlockedEdges` and `walkPath` both need.
 * `moverFootprint` defaults to a single square (#140: every pre-existing
 * caller that doesn't pass one keeps today's exact 1x1 behavior). */
function cellOccupied(cell, footprints, moverFootprint = { gw: 1, gh: 1 }) {
  return footprints.some((f) =>
    overlaps(
      { gx: cell.gx, gy: cell.gy, gw: moverFootprint.gw, gh: moverFootprint.gh },
      f,
    ),
  );
}

/**
 * A real, wall-aware path from `start` toward `targetCell` (#100) — straight
 * to it for an approach, or toward a point projected directly away from it
 * for a retreat, trying progressively shorter retreat distances if the
 * farthest one isn't reachable (a wall directly behind the retreater
 * shouldn't cancel the retreat outright, just shorten it). `speedSquares`
 * bounds how far a retreat goal is projected; how much of the returned path
 * is actually walked is still the caller's own speed clamp. Returns `null`
 * if no path exists at all. `reposition` (#103, hazard avoidance) shares
 * this exact "project directly away" branch with `retreat` — mechanically
 * identical (move away from a point), just away from a hazard's own
 * position instead of an opponent's, kept as its own `posture` value
 * upstream in `buildMovementCandidates`'s candidate data purely for a
 * distinct summary/intent, not a different movement algorithm.
 */
function posturePath(
  start,
  targetCell,
  posture,
  speedSquares,
  isBlocked,
  bounds,
  moverFootprint = { gw: 1, gh: 1 },
) {
  if (posture !== "retreat" && posture !== "reposition")
    return findPath(start, targetCell, isBlocked, bounds, 20000, moverFootprint);

  const dx = Math.sign(start.gx - targetCell.gx) || 1;
  const dy = Math.sign(start.gy - targetCell.gy) || 1;
  for (let dist = Math.max(1, speedSquares); dist >= 1; dist -= 1) {
    let gx = start.gx + dx * dist;
    let gy = start.gy + dy * dist;
    if (bounds) {
      gx = Math.min(Math.max(gx, bounds.gx0), bounds.gx1);
      gy = Math.min(Math.max(gy, bounds.gy0), bounds.gy1);
    }
    const path = findPath(
      start,
      { gx, gy },
      isBlocked,
      bounds,
      20000,
      moverFootprint,
    );
    if (path && path.length > 1) return path;
  }
  return null;
}

/**
 * #554 DIAGNOSTIC ONLY: after a hop-walk finishes, re-reads the mover's live
 * final footprint and every other still-alive combatant's live footprint,
 * and -- only if the mover ended on top of someone -- logs a console warning
 * and whispers the GM one chat message carrying everything needed to
 * reconstruct how it happened (the planned path/steps, the occupants
 * snapshot the move used vs. the live footprints, whether the token ended
 * where the plan said it would). Emits nothing at all for a normal move.
 * Never alters movement: it only reads, and any error inside is swallowed so
 * it can never throw into the caller's move. `combatant` is whichever
 * combatant's token was moved (the pushed target, for pushTokenAway).
 */
export async function reportMoveOverlap({
  combat,
  combatant,
  kind,
  posture = null,
  targetCombatant = null,
  startCell,
  goalCell,
  path,
  steps,
  occupantsSnapshot,
  speedSquares,
  stopWithin,
  gridSize,
  extra = null,
}) {
  try {
    const grid = gridSize ?? combat.scene?.grid?.size ?? 100;
    const mine = footprint(combatant.token, grid);
    const liveOthers = combat.combatants
      .filter((c) => c.id !== combatant.id && c.token)
      .map((c) => {
        const fp = footprint(c.token, grid);
        return {
          id: c.id,
          name: c.name ?? c.token?.name ?? null,
          x: c.token.x,
          y: c.token.y,
          cell: { gx: fp.gx, gy: fp.gy },
          disposition: c.token.disposition,
          isDefeated: !!c.isDefeated,
          width: c.token.width,
          height: c.token.height,
          fp,
        };
      });
    const hit = liveOthers.filter((o) => !o.isDefeated && overlaps(mine, o.fp));
    if (!hit.length) return false;

    const key = (f) => `${f.gx},${f.gy},${f.gw},${f.gh}`;
    const liveAliveKeys = liveOthers
      .filter((o) => !o.isDefeated)
      .map((o) => key(o.fp))
      .sort();
    const snapKeys = (occupantsSnapshot ?? []).map(key).sort();
    const occupantsChanged =
      JSON.stringify(liveAliveKeys) !== JSON.stringify(snapKeys);
    const lastStep = steps?.[steps.length - 1];
    const finalCellWasPlanned =
      !!lastStep && lastStep.gx === mine.gx && lastStep.gy === mine.gy;
    const cells = (list) => (list ?? []).map((c) => ({ gx: c.gx, gy: c.gy }));
    const payload = {
      kind,
      posture,
      mover: {
        id: combatant.id,
        name: combatant.name ?? combatant.token?.name ?? null,
        disposition: combatant.token.disposition,
        width: combatant.token.width,
        height: combatant.token.height,
      },
      startCell,
      goalCell,
      targetId: targetCombatant?.id ?? null,
      speedSquares,
      stopWithin,
      path: cells(path),
      steps: cells(steps),
      liveFinalCell: { gx: mine.gx, gy: mine.gy },
      overlapped: hit.map((o) => ({ id: o.id, name: o.name, cell: o.cell })),
      occupantsSnapshot: (occupantsSnapshot ?? []).map((f) => ({ ...f })),
      liveOthers: liveOthers.map(({ fp, ...rest }) => rest),
      occupantsChanged,
      finalCellWasPlanned,
      round: combat.round ?? null,
      turn: combat.turn ?? null,
      moduleVersion: game.modules?.get?.(MODULE_ID)?.version ?? null,
      ...(extra ?? {}),
    };
    console.warn(
      "pf2e-dungeon-crawl | move ended overlapping a combatant",
      payload,
    );
    const esc = (t) =>
      String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const moverName = payload.mover.name ?? payload.mover.id;
    const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
    await ChatMessage.create({
      content:
        `<p>Diagnostic #554: ${esc(moverName)} ended its ${esc(kind)} on ` +
        `${esc(hit[0].name ?? hit[0].id)}'s square</p>` +
        `<details><summary>Payload</summary><pre>${esc(
          JSON.stringify(payload, null, 2),
        )}</pre></details>`,
      whisper: gmIds,
    });
    return true;
  } catch (err) {
    console.debug("pf2e-dungeon-crawl | reportMoveOverlap failed", err);
    return false;
  }
}

/** #551 diagnostic: an agent Strike was about to roll but the target is
 * beyond the action's reach. Warns and whispers the GM once; never throws. */
async function reportStrikeOutOfReach({
  combat,
  combatant,
  target,
  candidate,
  distance,
  reach,
}) {
  try {
    const tok = (c) => ({
      id: c.id,
      name: c.name ?? c.token?.name ?? null,
      x: c.token?.x,
      y: c.token?.y,
      width: c.token?.width,
      height: c.token?.height,
    });
    const payload = {
      attacker: tok(combatant),
      target: tok(target),
      candidateId: candidate.id,
      actionSlug: candidate.actionSlug,
      distance,
      reach,
      round: combat.round ?? null,
      turn: combat.turn ?? null,
    };
    console.warn(
      "pf2e-dungeon-crawl | strike skipped: target out of reach",
      payload,
    );
    const esc = (t) =>
      String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
    await ChatMessage.create({
      content:
        `<p>Diagnostic #551: ${esc(payload.attacker.name ?? payload.attacker.id)} ` +
        `tried ${esc(candidate.actionSlug)} vs ` +
        `${esc(payload.target.name ?? payload.target.id)} but the target is ` +
        `${distance} squares away (reach ${reach}) — strike skipped</p>` +
        `<details><summary>Payload</summary><pre>${esc(
          JSON.stringify(payload, null, 2),
        )}</pre></details>`,
      whisper: gmIds,
    });
  } catch (err) {
    console.debug("pf2e-dungeon-crawl | reportStrikeOutOfReach failed", err);
  }
}

/** #554 diagnostic: the pre-move variant of reportMoveOverlap, called right
 * after a mover function's own snapTokenToGrid and before any early return
 * can fire -- catches an overlap that already existed or that the snap
 * itself produced (`preSnap` is the token's raw {x, y} captured before the
 * snap). Returns whether it reported, so the post-walk check can skip a
 * duplicate whisper for the same call. Never throws, never moves anything. */
async function reportPreMoveOverlap(fn, combat, combatant, preSnap, gridSize, target) {
  try {
    const t = combatant.token;
    return await reportMoveOverlap({
      combat,
      combatant,
      kind: `${fn}:pre-move`,
      targetCombatant: target ?? null,
      startCell: tokenCell(t, gridSize),
      gridSize,
      extra: {
        preSnapPosition: preSnap,
        snapMoved: preSnap.x !== t.x || preSnap.y !== t.y,
        earlyReturnPossible: true,
      },
    });
  } catch (err) {
    console.debug("pf2e-dungeon-crawl | reportPreMoveOverlap failed", err);
    return false;
  }
}

/** Raw {x, y} of `token` for the #554 pre-snap capture; never throws. */
function rawPosition(token) {
  return { x: token?.x, y: token?.y };
}

/**
 * Walks up to `speedSquares` steps of `path` (a findPath result, `path[0]`
 * === the mover's own current cell), stopping early once within
 * `stopWithinSquares` (Chebyshev) of `targetCell` — the same "don't
 * overshoot into melee range" clamp this module has always applied, now
 * checked per-waypoint against a possibly-curved route instead of computed
 * once for a straight line. `stopWithinSquares` of `0` (retreat's case)
 * never stops early; only the speed budget and the path's own length do.
 * `occupantFootprints` (#27) is every other combatant's footprint the mover
 * must never end its own movement on top of, ally or hostile — passing
 * through one of these cells on the way further along the path is still
 * fine, so a waypoint sitting on one is simply skipped as a candidate stop
 * rather than treated as blocking the route. Returns `{cell, steps}` —
 * `cell` is the destination {gx, gy} actually reached, `steps` is every
 * intermediate cell from the mover's own current cell up to and including
 * `cell`, in travel order — or `null` if the mover shouldn't move at all
 * (no path, or every waypoint is within the stop distance already or
 * occupied).
 */
function walkPath(
  path,
  targetCell,
  speedSquares,
  stopWithinSquares,
  occupantFootprints = [],
  moverFootprint = { gw: 1, gh: 1 },
) {
  let stepIndex = 0;
  for (let i = 1; i < path.length && i <= speedSquares; i += 1) {
    if (stopWithinSquares > 0) {
      const remaining = Math.max(
        Math.abs(path[i].gx - targetCell.gx),
        Math.abs(path[i].gy - targetCell.gy),
      );
      if (remaining < stopWithinSquares) break;
    }
    // #27: still allowed to pass through this cell (e.g. an ally's square)
    // on the way further along the path, but it never becomes the mover's
    // own final resting cell — only record it as a candidate stop if it's
    // unoccupied.
    if (!cellOccupied(path[i], occupantFootprints, moverFootprint)) {
      stepIndex = i;
    }
  }
  return stepIndex > 0
    ? { cell: path[stepIndex], steps: path.slice(1, stepIndex + 1) }
    : null;
}

/**
 * #606: fallback landing for an approach when `walkPath` found nothing on
 * the single shortest path (its penultimate cells were all held by allies,
 * e.g. a party member standing just inside a doorway, so the one A* route
 * had no unoccupied cell to stop on). Searches every cell within
 * `speedSquares` for an unoccupied one strictly closer to `targetCell` than
 * `start` (and not inside the `stopWithinSquares` clamp), reachable by a real
 * wall/hostile-aware path no longer than the speed budget (passing THROUGH
 * allies is still fine). Prefers the cell nearest the target, then the
 * shortest walk. Returns `{cell, steps}` like walkPath, or `null`.
 */
function fallbackLanding(
  start,
  targetCell,
  speedSquares,
  stopWithinSquares,
  isBlocked,
  bounds,
  occupantFootprints,
  moverFootprint = { gw: 1, gh: 1 },
) {
  const cheb = (a, b) => Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy));
  const startDist = cheb(start, targetCell);
  const candidates = [];
  for (let dx = -speedSquares; dx <= speedSquares; dx += 1) {
    for (let dy = -speedSquares; dy <= speedSquares; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const cell = { gx: start.gx + dx, gy: start.gy + dy };
      const d = cheb(cell, targetCell);
      if (d >= startDist) continue;
      if (stopWithinSquares > 0 && d < stopWithinSquares) continue;
      if (cellOccupied(cell, occupantFootprints, moverFootprint)) continue;
      candidates.push({ cell, d, walk: Math.max(Math.abs(dx), Math.abs(dy)) });
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.walk - b.walk);
  for (const { cell } of candidates) {
    const path = findPath(
      start,
      cell,
      (a, b) =>
        (b.gx === targetCell.gx && b.gy === targetCell.gy) || isBlocked(a, b),
      bounds,
      2000,
      moverFootprint,
    );
    // The approach's own target square is exempt from hostile blocking (so
    // findPath can reach it); a walk must still never pass through it.
    if (
      path &&
      path.length > 1 &&
      path.length - 1 <= speedSquares &&
      !path.some((p) => p.gx === targetCell.gx && p.gy === targetCell.gy)
    )
      return { cell, steps: path.slice(1) };
  }
  return null;
}

/**
 * #931: walks an AI Stride's `steps` (from `startCell`), resolving the
 * move-triggered reactions that can DISRUPT the move (Twisting Tail, Wing
 * Rebuff) at the exact square they fire -- the module owns AI movement, so
 * RAW timing is possible: the token walks up to the trigger square, the
 * reaction resolves there, and a disrupting result (Twisting Tail hit, Wing
 * Rebuff push) ends the move action where it stands (the action is still
 * spent). Without such a reaction the walk is one unchanged
 * `walkTokenThroughSteps` call. Reactive Strike keeps #202's own
 * end-of-Stride check (`strideEnd`). #932: `onlyDisrupting: false` (NPC
 * movement abilities) resolves every move-triggered reaction, Reactive
 * Strike included, at the square it fires on. Returns `{ disrupted }`.
 */
async function walkWithMoveReactions(combat, mover, startCell, steps, gridSize, skipReactorIds = new Set(), { onlyDisrupting = true } = {}) {
  const token = mover.token;
  const toPosition = (cell) => ({
    x: cell.gx * gridSize,
    y: cell.gy * gridSize,
    width: token?.width ?? 1,
    height: token?.height ?? 1,
  });
  let options = [];
  try {
    if (isModuleCombat(combat)) {
      options = collectStrikeReactionOptions(
        combat,
        mover,
        {
          trigger: "move",
          path: [startCell, ...steps].map(toPosition),
          onlyDisrupting,
          skipReactorIds,
        },
        gridSize,
        combat.scene?.grid?.distance ?? 5,
      );
    }
  } catch (err) {
    console.error(`${MODULE_ID} | #931: move-reaction check failed:`, err?.message ?? err);
  }
  if (!options.length) {
    await walkTokenThroughSteps(token, steps, gridSize);
    return { disrupted: false };
  }
  const firstIndex = Math.min(...options.map((o) => o.ctx.triggerIndex));
  const atTrigger = options.filter((o) => o.ctx.triggerIndex === firstIndex);
  const before = steps.slice(0, firstIndex);
  if (before.length) await walkTokenThroughSteps(token, before, gridSize);
  const ran = await resolveReactions(combat, { trigger: "move", mover, options: atTrigger }, (chosen, decision) =>
    executeStrikeReaction(combat, chosen, mover, decision),
  );
  if (ran.some((r) => r.result?.disrupted) || mover.isDefeated) {
    await postMoveDisruptedNote(mover, ran.find((r) => r.result?.disrupted) ?? null);
    return { disrupted: true };
  }
  const rest = steps.slice(firstIndex);
  if (!rest.length) return { disrupted: false };
  for (const o of atTrigger) skipReactorIds.add(o.reactor.id);
  const restStart = firstIndex === 0 ? startCell : steps[firstIndex - 1];
  return walkWithMoveReactions(combat, mover, restStart, rest, gridSize, skipReactorIds, { onlyDisrupting });
}

/** #931: tells the table a reaction disrupted `mover`'s move action. */
async function postMoveDisruptedNote(mover, disruptor) {
  if (!disruptor) return;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  await ChatMessage.create({
    content: game.i18n.format("PF2EDC.Dungeon.Combat.ReactionDisruptedMove", {
      name: esc(disruptor.reactor.name),
      reaction: esc(disruptor.def.label),
      target: esc(mover.name),
    }),
  });
}

/**
 * Moves `combatant`'s token toward `target`'s token along a real,
 * wall-aware path (#100), up to its own speed, stopping once adjacent
 * (MELEE_REACH_SQUARES). A no-op (beyond `snapTokenToGrid`'s own possible
 * correction, #86) if already adjacent, if the combatant has no speed to
 * move with, or if no path to the target exists at all.
 */
export async function stepToward(combat, combatant, target, distanceSquares) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const preSnap = rawPosition(combatant.token);
  await snapTokenToGrid(combatant.token, gridSize);
  const preReported = await reportPreMoveOverlap(
    "stepToward",
    combat,
    combatant,
    preSnap,
    gridSize,
    target,
  );
  if (distanceSquares <= MELEE_REACH_SQUARES) return "already-there";
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  // Confirmed live: an NPC's land speed lives at system.movement.speeds.land,
  // not system.attributes.speed (which doesn't exist) — the wrong path
  // silently gave 0 in an earlier version of this function, so nothing ever
  // moved.
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0) return "no-speed";

  const me = combatant.token;
  const dest = target.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const goal = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(combat, combatant, goal);
  const path = findPath(start, goal, isBlocked, bounds, 20000, moverFootprint);
  if (!path) return "no-route";

  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const waypoint = walkPath(
    path,
    goal,
    speedSquares,
    MELEE_REACH_SQUARES,
    occupants,
    moverFootprint,
  ) ??
    fallbackLanding(
      start,
      goal,
      speedSquares,
      MELEE_REACH_SQUARES,
      isBlocked,
      bounds,
      occupants,
      moverFootprint,
    );
  if (!waypoint) return "blocked";
  // #931: Twisting Tail / Wing Rebuff fire mid-move and can stop it.
  const walk = await walkWithMoveReactions(combat, combatant, start, waypoint.steps, gridSize);
  if (!preReported && !walk.disrupted)
  await reportMoveOverlap({
    combat,
    combatant,
    kind: "stepToward",
    targetCombatant: target,
    startCell: start,
    goalCell: goal,
    path,
    steps: waypoint.steps,
    occupantsSnapshot: occupants,
    speedSquares,
    stopWithin: MELEE_REACH_SQUARES,
    gridSize,
  });
  await offerReactiveStrikesAgainst(combat, combatant, { trigger: "strideEnd" });
  return walk.disrupted ? "disrupted" : "moved";
}

/**
 * Moves `target`'s token directly away from `attacker`'s token along a
 * real, wall-aware path, up to `distanceSquares` -- #51's push/
 * improved-push rider resolution (a real Shove attempt's forced
 * movement). Reuses `posturePath`'s own "retreat" branch as-is: it already
 * projects a point directly away from a reference cell and shortens the
 * distance progressively if the farthest one isn't reachable, so calling
 * it with `attacker`'s cell as that reference point and `target` as the
 * mover gets the exact same "shorten instead of cancel" behavior a wall
 * right behind the target should have, with no new projection logic of
 * its own. `stopWithinSquares: 0` in the `walkPath` call, same as
 * `posturePath`'s own retreat callers use, since a push has no "stop
 * short of melee range" concept to honor. A no-op beyond `snapTokenToGrid`'s
 * own possible correction (#86) if `target` has nowhere to go -- fully
 * boxed in by walls or other combatants -- rather than throwing.
 */
export async function pushTokenAway(combat, attacker, target, distanceSquares) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const preSnap = rawPosition(target.token);
  await snapTokenToGrid(target.token, gridSize);
  const preReported = await reportPreMoveOverlap(
    "pushTokenAway",
    combat,
    target,
    preSnap,
    gridSize,
    attacker,
  );
  const moverFootprint = footprint(target.token, gridSize);
  const start = tokenCell(target.token, gridSize);
  const awayFrom = tokenCell(attacker.token, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(combat, target);
  const path = posturePath(
    start,
    awayFrom,
    "retreat",
    distanceSquares,
    isBlocked,
    bounds,
    moverFootprint,
  );
  if (!path) return;

  const occupants = otherCombatantFootprints(combat, target, gridSize);
  const waypoint = walkPath(
    path,
    awayFrom,
    distanceSquares,
    0,
    occupants,
    moverFootprint,
  );
  if (!waypoint) return;
  await walkTokenThroughSteps(target.token, waypoint.steps, gridSize);
  if (!preReported)
  await reportMoveOverlap({
    combat,
    combatant: target,
    kind: "pushTokenAway",
    posture: "retreat",
    targetCombatant: attacker,
    startCell: start,
    goalCell: awayFrom,
    path,
    steps: waypoint.steps,
    occupantsSnapshot: occupants,
    speedSquares: distanceSquares,
    stopWithin: 0,
    gridSize,
  });
}

/**
 * PF2e's own `applyDamage` never applies any condition on its own — confirmed
 * live (#107): a real critical hit took a scratch NPC from 1 HP to 0 with
 * zero condition change. `Combatant#isDefeated` (which `combatSideStatus`
 * needs to auto-resolve a fight) only needs the raw `defeated` flag or the
 * actor having PF2e's 'dead' status — neither happens on its own, so without
 * this, combat can never auto-resolve once a strike (heuristic or
 * agent-controlled) reduces someone to 0 HP.
 *
 * For an NPC, `Combatant#toggleDefeated()` — the real Foundry core method
 * the GM's own Combat Tracker skull-toggle calls — is the correct call, not
 * a hand-rolled `update({defeated: true})` (#152: that alone sets the
 * bookkeeping flag `isDefeated`/`combatSideStatus` need, but leaves the
 * token visually unmarked and never applies PF2e's actual Dead condition,
 * so players looking at the map can't tell an NPC is down). Confirmed
 * against Foundry/PF2e's own source rather than a live world this time:
 * `Combatant#toggleDefeated()` itself calls
 * `token.actor.toggleStatusEffect('dead', {overlay: true})`, and PF2e's
 * `ActorPF2e#toggleStatusEffect` override routes any real condition slug
 * (which `'dead'` is, per `CONFIG.specialStatusEffects.DEFEATED === 'dead'`)
 * straight to `toggleCondition` — i.e. it applies the actual Dead condition
 * item, the same as hand-toggling the skull icon. For a party member, PF2e's
 * own `actor.increaseCondition('dying')` is the correct call: it's the
 * system's real API and correctly cascades Unconscious/Blinded/Prone/
 * Off-Guard automatically (confirmed live) — hand-rolling that cascade
 * ourselves would risk getting real PF2e rules wrong against an actual
 * player's character. Called on every hit that leaves HP at or below 0, not
 * just the first — a party member already dying who's hit again should have
 * their dying value increase further, per PF2e's own rules, not be skipped
 * as "already handled."
 */
async function applyDefeatIfReducedToZero(target) {
  if ((target.actor?.system?.attributes?.hp?.value ?? 1) > 0) return;
  if (target.actor?.type === "character") {
    await target.actor.increaseCondition("dying");
  } else if (!target.isDefeated) {
    await target.toggleDefeated();
    // #95: a party member going to 'dying' isn't death yet, per PF2e's own
    // rules (they can still be stabilized) — only an NPC actually defeated
    // here gets the death sound.
    playCreatureDeathSound();
    // #933: a defeated creature neither holds nor stays held in a grab.
    const combat = target.parent ?? target.combat ?? null;
    if (typeof combat?.setFlag === "function") await clearGrabsInvolving(combat, target.id);
  }
}

/** Grid cells currently occupied by an undestroyed cover item (#96) on this
 * combat's scene — a hazard actor cover-items.mjs's spawnCoverItems flagged
 * `flags["pf2e-dungeon-crawl"].coverItem` at spawn time, filtered to ones that still have HP
 * (a destroyed cover item no longer blocks a line of fire, whatever state
 * its token/actor happen to still be in on the scene). */
function activeCoverCells(combat) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  return livingCoverTokens(combat).map((t) => tokenCell(t, gridSize));
}

/** Single source of truth for "living cover" (#96, #567): scene tokens
 * flagged `coverItem` whose actor still has HP. Corpses, destroyed cover
 * and any other non-combatant token are never included. */
function livingCoverTokens(combat) {
  return (combat.scene?.tokens ?? []).filter(
    (t) =>
      t.getFlag(MODULE_ID, "coverItem") &&
      (t.actor?.system?.attributes?.hp?.value ?? 0) > 0,
  );
}

/** Footprints of every living cover item (#567) -- impassable and
 * unlandable for AI combat movement. */
function livingCoverFootprints(combat, gridSize) {
  return livingCoverTokens(combat).map((t) => footprint(t, gridSize));
}

/**
 * Runs `roll` with a temporary +2 circumstance AC effect (#96,
 * COVER_EFFECT_DATA) applied to `target`'s actor if a cover item stands
 * between `attacker` and `target` — removed again immediately after, in a
 * `finally`, so the bonus applies to exactly this one roll and never
 * lingers on the actor afterward. PF2e's own FlatModifier rule element does
 * the real work of folding it into the attack roll's DC comparison; this
 * only decides whether it applies for this specific attacker/target pair
 * and cleans up after itself.
 */
async function withCoverBonus(combat, attacker, target, roll) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const coverCells = activeCoverCells(combat);
  const covered =
    coverCells.length > 0 &&
    coverBlocksLineOfFire(
      tokenCell(attacker.token, gridSize),
      tokenCell(target.token, gridSize),
      coverCells,
    );
  let effect = null;
  if (covered) {
    [effect] = await target.actor.createEmbeddedDocuments("Item", [
      COVER_EFFECT_DATA,
    ]);
  }
  try {
    return await roll();
  } finally {
    if (effect) await effect.delete();
  }
}

/**
 * The plain-value context playStrikeSound (dungeon-sound.mjs) needs to pick
 * a hit sound, pulled off a live strike/target — kept as a thin extraction
 * step so the actual bucketing logic stays pure and testable there.
 *
 * `weaponGroup` comes from `item.system.group`, which only a real Weapon
 * item carries (a party member's own gear) — a monster's synthetic
 * "melee"/"ranged" strike item has no group at all, so `weaponGroup` only
 * ever matters for the ranged bow/crossbow split, where it's a player
 * weapon either way.
 *
 * `damageType` needed two different paths, confirmed live against both a
 * real weapon and a monster's natural attack — a real Weapon item (a
 * Longsword) carries it as the *singular* `system.damage.damageType`, but a
 * monster's synthetic strike item has no `system.damage` at all and carries
 * it instead in `system.damageRolls`, a map of one-or-more named damage
 * instances. Checking only the first (monster) path silently left every
 * player weapon attack with no damage type at all, always falling through
 * to the bludgeoning default regardless of the weapon actually swung.
 *
 * `blocked` is a heuristic, not a confirmed Shield Block reaction: PF2e
 * exposes no "was Shield Block used on this hit" flag to check directly, so
 * this reads whether the target's shield was raised at the moment the hit
 * landed instead — true whenever Shield Block was available to use, whether
 * or not the player actually triggered it.
 */
function strikeSoundContext(strike, target) {
  const damageRolls = Object.values(strike.item?.system?.damageRolls ?? {});
  return {
    isRanged: !!strike.item?.isRanged,
    weaponGroup: strike.item?.system?.group ?? null,
    damageType:
      strike.item?.system?.damage?.damageType ??
      damageRolls[0]?.damageType ??
      null,
    blocked: target.actor?.system?.attributes?.shield?.raised === true,
  };
}

/**
 * Draws a hit-deck critical card and returns its damage multiplier (#61 --
 * 1/2/3, default 1) -- the one "draw + extract damageMultiplier" step
 * shared by both #61 (Strikes, via `drawCriticalCardForStrike` below) and
 * #75 (spell-attack crits, `castAttackSpellAndApplyRoll`). Deliberately
 * does NOT decide how a caller applies the multiplier: `strike.damage()`
 * already pre-doubles on a critical hit, so a Strike only needs an
 * ADDITIONAL scaling on top of that (`.alter(1.5, 0)` for a card's
 * "Triple damage."); `spell.rollDamage()` never pre-doubles, so a spell
 * needs the FULL multiplier applied instead (`.alter(3, 0)`). That math
 * genuinely differs per caller and stays at each call site -- unifying it
 * here would be the wrong kind of "sharing" (deduping code that isn't
 * actually the same operation).
 */
async function drawHitCardMultiplier(
  category,
  { combatant, target, damageType },
) {
  const draw = await drawAndApplyCriticalCard("hit", category, {
    combatant,
    target,
    damageType,
  });
  return draw?.damageMultiplier ?? 1;
}

/**
 * Draws a #28 critical-deck card for a Strike's outcome, right alongside the
 * existing playStrikeSound call -- a no-op for any outcome other than a
 * clean crit/fumble. `soundContext` is `strikeSoundContext`'s own result,
 * reused here rather than recomputed: its `damageType`/`isRanged` are
 * exactly the signals the Hit/Fumble deck category derivation is defined
 * against. `strike.item?.system?.category === "unarmed"` is PF2e's own
 * weapon-item field for this (confirmed against the system's Weapon data
 * model: `category` is one of "unarmed"/"simple"/"martial"/"advanced" --
 * the same field already gates access-to-training feats elsewhere in the
 * system).
 *
 * Returns the drawn card's damage multiplier (#61 -- 1/2/3, default 1) so
 * the caller can `.alter()` its own already-in-flight `strike.damage()`
 * roll once it resolves; only ever non-1 on the criticalSuccess/hit-deck
 * branch (a fumble has no damage roll to scale).
 *
 * #976: `natural` is the attack roll's own natural d20 face
 * (`naturalD20`, read off the attack message the caller captured) -- a
 * card only draws on a natural 20 crit / natural 1 fumble
 * (`criticalCardKindFor`); a 10+-margin crit/fumble on any other face, or
 * an unknown face, returns 1 and draws nothing. The caller's own crit
 * damage (strike.damage()'s pre-doubling) is unaffected either way.
 */
async function drawCriticalCardForStrike(
  outcome,
  strike,
  soundContext,
  combatant,
  target,
  natural = null,
) {
  const kind = criticalCardKindFor(outcome, natural);
  if (kind === "hit") {
    return drawHitCardMultiplier(hitDeckCategory(soundContext.damageType), {
      combatant,
      target,
      damageType: soundContext.damageType,
    });
  } else if (kind === "fumble") {
    await drawAndApplyCriticalCard(
      "fumble",
      fumbleDeckCategory({
        isRanged: soundContext.isRanged,
        isUnarmed: strike.item?.system?.category === "unarmed",
      }),
      // #60: `strike` lets a weapon-HP-damage fumble card resolve the
      // attacker's actual weapon item -- never threaded into the
      // criticalSuccess/hit-deck branch above, since a weapon breaking
      // from fumbling doesn't apply on a crit success.
      { combatant, target, strike },
    );
  }
  return 1;
}

/**
 * Rolls `combatant`'s first ready strike against `target` and, on a hit,
 * rolls and applies damage — confirmed live (see ITEM-8 in docs/backlog.md):
 * a strike's own roll()/damage() never forwards a skipDialog option, so the
 * *user's* own showCheckDialogs/showDamageDialogs flags are toggled off for
 * the duration and always restored in the finally, even on error. `{document:
 * target.token}` as the roll target works with no dependency on which scene
 * is currently rendered on this client's canvas.
 */
export async function rollAndApplyStrike(combat, combatant, target) {
  // #551: only a strike whose reach covers the current distance may roll;
  // out of reach after a short/blocked move is normal here, so stay silent.
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const strike = combatant.actor?.system?.actions?.find(
    (a) =>
      a.type === "strike" &&
      a.ready !== false &&
      strikeInReach(combatant, target, a, gridSize, gridDistanceFt).inReach,
  );
  if (!strike) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });

  try {
    return await withCoverBonus(combat, combatant, target, async () => {
      const targetRef = { document: target.token };
      await strike.variants[0].roll({ target: targetRef, createMessage: true });
      // #976: capture the attack message itself right here -- the rider
      // resolution below can post further chat messages before the card
      // draw, so a later `.at(-1)` would no longer be the attack roll.
      const attackMessage = game.messages.contents.at(-1);
      // #931: an AC-bonus reaction (Wing Deflection, ...) may turn this hit
      // into a miss before any rider, card or damage resolves.
      const outcome = await applyTargetedByAttackReactions(
        combat,
        combatant,
        target,
        attackMessage,
        attackMessage?.flags?.pf2e?.context?.outcome ?? null,
      );
      const natural = naturalD20(attackMessage?.rolls?.[0]);
      const soundContext = strikeSoundContext(strike, target);
      playStrikeSound(outcome, soundContext);
      await postStrikeRiderReminder(combatant, strike, outcome);
      await resolveGrabRider(combatant, target, strike, outcome, combat);
      await resolveKnockdownRider(combatant, target, strike, outcome);
      await resolveAthleticsRider(combatant, target, strike, outcome, {
        slugs: PUSH_RIDER_SLUGS,
        saveKey: "fortitude",
        label: "Push",
        onSuccess: async (rollOutcome) => {
          const distanceSquares = rollOutcome === "criticalSuccess" ? 2 : 1;
          await pushTokenAway(combat, combatant, target, distanceSquares);
          return `target is pushed ${distanceSquares * 5} feet away`;
        },
      });
      const damageMultiplier = await drawCriticalCardForStrike(
        outcome,
        strike,
        soundContext,
        combatant,
        target,
        natural,
      );
      if (outcome === "success" || outcome === "criticalSuccess") {
        const damageRoll = await strike.damage({
          target: targetRef,
          outcome,
          createMessage: true,
        });
        if (damageRoll) {
          // #61: a critical-deck card's own Triple/Double-damage text
          // (e.g. "Disembowel", "Corrosive") is a card-drawn Hit-deck
          // effect, only ever drawn here on outcome === "criticalSuccess"
          // -- strike.damage() above already applied PF2e's own crit
          // doubling for that outcome (confirmed live strike.damage(), unlike
          // spell.rollDamage() -- see #81 -- DOES pre-double on a crit), so a
          // card's "double damage" (damageMultiplier 2) is already
          // exactly what that doubling gives -- no extra scaling needed.
          // Only "triple damage" (damageMultiplier 3) needs an
          // ADDITIONAL 1.5x on top of the existing 2x, to reach 3x total
          // rather than stacking to 6x.
          if (damageMultiplier === 3) {
            await damageRoll.alter(1.5, 0);
          }
          // #931: Shield Block -- the system applies Hardness itself.
          const shieldBlock = await resolveShieldBlockForHit(combat, combatant, target, damageRoll);
          await target.actor.applyDamage({
            damage: damageRoll,
            token: target.token,
            outcome,
            ...(shieldBlock ? { shieldBlockRequest: true } : {}),
          });
          await applyDefeatIfReducedToZero(target);
          // Critical specialization's own Note (#36) only ever lands on the
          // DAMAGE message strike.damage() just created above, not the
          // attack-roll message `outcome` was read from -- see
          // dungeon-strike-riders.mjs's file header for why.
          await postCriticalSpecializationReminder(combatant, outcome);
        }
      }
      return outcome;
    });
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Hook target for `updateCombat` — module.mjs registers this whenever the
 * turn or round changes. Plays the current combatant's turn automatically if
 * it isn't a real party member: move adjacent to the nearest opponent if not
 * already, strike once, apply the result, advance the turn. A real party
 * character's own combatant is left entirely alone — checked by membership
 * in `game.actors.party.members` (`partyActorIds`), not Foundry's
 * `hasPlayerOwner`, which came back false for actual party actors on the
 * real deployed world (a solo-GM world with no separate player-role users)
 * and let their turns get auto-played right alongside the NPCs. If the next
 * combatant is also non-party, this fires again naturally off that same
 * `nextTurn()` call — no explicit recursion needed here.
 */
export async function autoPlayCombatantTurnIfDue(combat) {
  if (!game.user.isGM || !isModuleCombat(combat)) return;
  unpauseIfGmLessRun(combat.scene?.id);
  const combatant = combat.combatant;
  if (!combatant) return;
  // #20: check the already-authoritative flag before re-deriving party
  // membership — a real party actor's own hasPlayerOwner is true under
  // this deployment's actual ownership model (each Trusted-User player
  // OWNERs their own actor), so re-deriving eligibility here instead of
  // trusting the flag startCombat already set would let this exclusion
  // fire even for a run's AI-controlled party actor. Leaves the
  // pre-existing exclusion of a manually-added, player-summoned ally
  // (which never receives this flag) completely unchanged.
  if (isExcludedFromAutoPlay(combatant, partyActorIds())) return;

  if (combatant.isDefeated) {
    await combat.nextTurn();
    return;
  }

  // #616: every sneaker unnoticed -> no offensive action; end the turn at once
  // on both paths (agent path must not call the service or arm the timeout).
  if (isUnawareHostile(combat, combatant)) {
    await endUnawareTurn(combat, combatant);
    return;
  }

  if (combatant.getFlag(MODULE_ID, "agentControlled")) {
    // Not awaited — arms a background timeout and returns immediately, same
    // fire-and-forget style module.mjs's own updateCombat hook already uses
    // to call this function. runAgentDecisionLoop is the thing that actually
    // decides and applies this turn's actions against the hosted agent
    // service; armAgentTimeout is only the heuristic fallback that fires if
    // that loop never resolves in time (unconfigured service, slow/failed
    // fetch, etc.) — it races runAgentDecisionLoop rather than depending on
    // it.
    armAgentTimeout(combat, combatant);
    runAgentDecisionLoop(combat, combatant);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, AUTO_PLAY_DELAY_MS));
  // Another client (or the combat auto-resolving mid-wait) may have already
  // moved things on — don't act on a stale turn.
  if (!game.combats.has(combat.id) || combat.combatant?.id !== combatant.id)
    return;
  await playHeuristicTurn(combat, combatant);
}

/** ITEM-8's original heuristic turn: move adjacent to the nearest opponent
 * if not already, strike once, apply the result, advance the turn — shared
 * by the non-agent-controlled path above and the agent-timeout fallback
 * below, so both use exactly the same behavior. */
export async function playHeuristicTurn(
  combat,
  combatant,
  { move = stepToward, strike = rollAndApplyStrike, seek = performSeek, delayMs } = {},
) {
  const pace = () =>
    new Promise((resolve) => setTimeout(resolve, delayMs ?? actionPaceDelayMs()));
  // #616: an unaware hostile does nothing; a hostile with no observed target
  // but hidden/undetected sneakers Seeks (one action each, up to its 3).
  if (isUnawareHostile(combat, combatant)) {
    await endUnawareTurn(combat, combatant);
    return;
  }
  let actionsLeft = 3;
  let target = nearestOpponent(combat, combatant);
  while (!target && actionsLeft > 0 && seekableSneakerIds(combat, combatant).length) {
    await seek(combat, combatant);
    actionsLeft -= 1;
    target = nearestOpponent(combat, combatant);
    if (!target && actionsLeft > 0) await pace();
  }
  if (target) {
    // Unchanged behavior at a full 3 actions (move + strike). After Seeking,
    // a single action left is spent on the strike if adjacent, else the move.
    const canMove = actionsLeft >= 2 || target.distanceSquares > 1;
    const canStrike = actionsLeft >= 2 || target.distanceSquares <= 1;
    if (canMove) await move(combat, combatant, target.combatant, target.distanceSquares);
    if (canMove && canStrike) await pace();
    if (canStrike) await strike(combat, combatant, target.combatant);
  }
  if (game.combats.has(combat.id) && combat.combatant?.id === combatant.id) {
    await combat.nextTurn();
  }
}

// --- Task 3: external agent-controlled turn decisions --------------------

/**
 * The current decision point for the due combatant, or `null` if there's
 * nothing for an external agent to decide right now (no combat due, the
 * current combatant isn't agent-controlled, or it's already defeated). The
 * *only* read surface `tools/agent-loop`'s poller uses — see module.mjs's
 * api.getPendingAgentTurn.
 */
export async function getPendingAgentTurn(combat) {
  if (!isModuleCombat(combat)) return null;
  const combatant = combat.combatant;
  if (
    !combatant ||
    combatant.isDefeated ||
    !combatant.getFlag(MODULE_ID, "agentControlled")
  )
    return null;

  const turnState = getAgentTurnState(combat, combatant.id);
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;

  const rawOpponents = combatantTargets(combat, combatant);
  const rawAllies = combatantAllies(combat, combatant);
  // #91: every opponent-facing ranged/spell target-eligibility check below
  // needs "is there actually a clear shot," not just "is it in range" — a
  // wall-blocked opponent still appears in `opponents` (movement/approach
  // candidates still need to know it's there and how far away), but is
  // flagged so agent-candidates.mjs's strike/spell candidate builders (and
  // this function's own chain/target-count/dual-nature filtering below)
  // can exclude it from anything that actually requires a line of sight.
  const canSee = (c) => hasLineOfSight(combat, combatant.token, c.token);
  // #922: this actor's own TokenMark effects (Hunt Prey, Devise a
  // Stratagem) bound to an opponent's token -- surfaced on that opponent
  // (and so on Strike summaries against it); absent when unmarked.
  const ownEffects = combatant.actor?.itemTypes?.effect ?? [];
  const opponents = rawOpponents.map((c) => {
    const annotation = markAnnotation(findActiveMarkEffects(ownEffects, c.token?.uuid));
    return {
      id: c.id,
      name: c.name,
      distanceSquares: chebyshevSquares(combatant.token, c.token, gridSize),
      hp: c.actor?.system?.attributes?.hp?.value ?? null,
      hasLineOfSight: canSee(c),
      ...(annotation ? { markAnnotation: annotation } : {}),
    };
  });
  const allies = rawAllies.map((c) => ({
    id: c.id,
    name: c.name,
    distanceSquares: chebyshevSquares(combatant.token, c.token, gridSize),
    hp: c.actor?.system?.attributes?.hp?.value ?? null,
    maxHp: c.actor?.system?.attributes?.hp?.max ?? null,
  }));

  const readyActions = (combatant.actor?.system?.actions ?? [])
    .filter((a) => a.type === "strike" && a.ready !== false)
    .map((a) => ({
      slug: a.item?.slug ?? a.slug ?? a.label,
      label: a.label,
      variantCount: a.variants?.length ?? 1,
      reachSquares: actionReachSquares(a, gridDistanceFt),
    }));
  const hasRangedOrReach = readyActions.some(
    (a) => a.reachSquares > MELEE_REACH_SQUARES,
  );

  // #909: the (maneuver, target) pairs that are RAW-legal this turn --
  // Foundry decides legality here; the agent service's reasoning model only
  // ever selects from this list (see runAgentDecisionLoop).
  const maneuverAttackerProfile = computeManeuverAttackerProfile(combatant.actor);
  const worldTime = globalThis.game?.time?.worldTime ?? 0;
  const maneuverOpponents = rawOpponents.map((o) => {
    const sizeOk = Object.fromEntries(
      MELEE_MANEUVER_SLUGS.map((slug) => [
        slug,
        sizeOkForManeuver(combatant.actor, o.actor, maneuverAttackerProfile[slug].sizeCapSteps),
      ]),
    );
    return {
      id: o.id,
      name: o.name,
      distanceSquares: chebyshevSquares(combatant.token, o.token, gridSize),
      hasLineOfSight: canSee(o),
      sizeOk,
      holdsItem: holdsAnItem(o.actor),
      demoralizeImmune:
        immuneToDemoralize(o.actor) ||
        worldTime < getDemoralizeImmunityUntil(combat, combatant.id, o.id),
    };
  });
  const maneuverVocabulary = buildManeuverVocabulary({
    attacker: { maneuvers: maneuverAttackerProfile },
    opponents: maneuverOpponents,
  });

  // #910: the feat/class actions (self-effects, the composite Sudden
  // Charge/Lunge/Twin Feint allowlist and #922's targeted self-effects)
  // that are legal this turn --
  // sent to the same once-per-turn reasoning call as the maneuvers.
  // #922/#946/#947: the opponents a targeted feat can choose, with their
  // token (TokenMark), PF2e distance ("within N feet") and actor.
  const featTargetOpponents = rawOpponents.map((c, i) => ({
    id: c.id,
    name: c.name,
    hasLineOfSight: opponents[i].hasLineOfSight,
    distanceSquares: opponents[i].distanceSquares,
    tokenUuid: c.token?.uuid ?? null,
    // #946: "within N feet" constraints/requirements, "non-mindless".
    distanceFeet: pf2eDistanceFeet(combatant.token, c.token, gridSize, gridDistanceFt),
    actor: c.actor,
  }));
  const featVocabulary = buildFeatVocabulary({
    selfEffectEntries: await computeSelfEffectVocabularyEntries(
      combatant.actor,
      turnState.actionsRemaining,
    ),
    compositeEntries: computeCompositeVocabularyEntries(
      combatant.actor,
      opponents,
      turnState.actionsRemaining,
      gridDistanceFt,
    ),
    // #922/#946: marked-target self-effects (Hunt Prey, Devise a
    // Stratagem, Smite, ...), one entry per legal target.
    targetedSelfEffectEntries: await computeTargetedSelfEffectVocabularyEntries(
      combatant.actor,
      featTargetOpponents,
      turnState.actionsRemaining,
    ),
    // #947: targeted feats with no selfEffect (Intimidating Strike,
    // Unbalancing Finisher, Instant Opening, ...), one entry per legal target.
    targetedActionEntries: computeTargetedActionVocabularyEntries(
      combatant.actor,
      featTargetOpponents,
      turnState,
      gridDistanceFt,
    ),
    turnState,
  });

  // #915: NPC save-based special abilities (Terrifying Display, Vanth's
  // Curse, ...), the third category sent to the same once-per-turn call.
  const npcAbilityVocabulary = await computeNpcAbilityVocabulary(
    combat,
    combatant,
    rawOpponents,
    rawAllies,
    opponents,
    turnState.actionsRemaining,
    gridSize,
  );

  // #932: NPC movement abilities (Gallop, Swift Leap, Swoop, Phase Jump,
  // ...), the fourth category in the same once-per-turn call.
  const npcMoveVocabulary = buildNpcMoveVocabulary({
    npcMoveEntries: computeNpcMoveEntries(combat, combatant, rawOpponents, turnState.actionsRemaining),
    opponents,
    hasRangedOrReach,
    turnState,
    describe: (entry, { posture, targetName }) =>
      describeNpcMove(entry.plan, { mode: entry.mode, feet: entry.feet, posture, targetName }),
  });

  // #933: NPC Strike-plus abilities (Death Roll, Constrict, Wide Swing,
  // Mangling Rend, Hurl Net, Rend, ...), the fifth category in the same
  // once-per-turn call.
  const npcStrikeVocabulary = buildNpcStrikeVocabulary({
    npcStrikeEntries: computeNpcStrikeEntries(combat, combatant, rawOpponents, turnState.actionsRemaining),
    opponents,
    turnState,
    describe: (entry, targetNames) => describeStrikePlus(entry.descriptor, targetNames),
  });

  // #934: NPC self-buff and self-heal abilities (Form a Phalanx, Reef Armor,
  // Feed on Fear, Self-Repair, ...), the sixth category in the same
  // once-per-turn call.
  const npcSelfVocabulary = buildNpcSelfVocabulary({
    npcSelfEntries: await computeNpcSelfEntries(combat, combatant, turnState.actionsRemaining),
    turnState,
  });

  const readySpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const rangeSquares = spellRangeSquares(spell, gridDistanceFt);
          if (rangeSquares == null) return null;
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            cost: Number(spell.system.time.value),
            rangeSquares,
            save: spell.system.defense.save.statistic,
            basic: spell.system.defense.save.basic,
            entryId: entry.id,
          };
        }),
    )
    .filter(Boolean);

  const readyVariableCostSpells = (
    combatant.actor?.spellcasting?.contents ?? []
  )
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isVariableCostSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const cost = minimumVariableCost(spell);
          const rangeSquares = minimumTierRangeSquares(spell, gridDistanceFt);
          if (cost == null || rangeSquares == null) return null;
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            cost,
            rangeSquares,
            save: spell.system.defense.save.statistic,
            basic: spell.system.defense.save.basic,
            entryId: entry.id,
          };
        }),
    )
    .filter(Boolean);

  const readyAreaSpells = [];
  for (const entry of combatant.actor?.spellcasting?.contents ?? []) {
    for (const spell of (entry.spells?.contents ?? [])
      .filter(isAreaSpellInScope)
      .filter(hasSpellUsesRemaining)
      .filter((spell) => hasSpellSlotRemaining(spell, entry))) {
      const radiusFeet = spell.system.area.value ?? 0;
      const centers =
        spell.system.area.type === "emanation"
          ? [
              {
                centerType: "self",
                centerId: null,
                originToken: combatant.token,
              },
            ]
          : rawOpponents.map((o) => ({
              centerType: "opponent",
              centerId: o.id,
              originToken: o.token,
            }));
      const placements = await computeAreaPlacements(
        combat,
        centers,
        rawOpponents,
        rawAllies,
        radiusFeet,
      );
      readyAreaSpells.push({
        id: spell.id,
        slug: spell.slug,
        label: spell.name,
        cost: Number(spell.system.time.value),
        save: spell.system.defense.save.statistic,
        basic: spell.system.defense.save.basic,
        entryId: entry.id,
        placements,
      });
    }
  }

  // One entry per (spell, tier) pair — a #140-scoped tier-scaling area
  // spell offers a separate castAreaTier candidate for each affordable
  // cost tier, each with its own radius (and therefore its own real
  // placements, computed the same way #119's readyAreaSpells does, just
  // parameterized per tier instead of using the spell's single structured
  // radius).
  const readyTierScalingAreaSpells = [];
  for (const entry of combatant.actor?.spellcasting?.contents ?? []) {
    for (const spell of (entry.spells?.contents ?? [])
      .filter(isTierScalingAreaSpellInScope)
      .filter(hasSpellUsesRemaining)
      .filter((spell) => hasSpellSlotRemaining(spell, entry))) {
      const tiers = resolveAreaSpellTiers(spell);
      const centers =
        spell.system.area.type === "emanation"
          ? [
              {
                centerType: "self",
                centerId: null,
                originToken: combatant.token,
              },
            ]
          : rawOpponents.map((o) => ({
              centerType: "opponent",
              centerId: o.id,
              originToken: o.token,
            }));
      for (const tier of Object.values(tiers)) {
        const placements = await computeAreaPlacements(
          combat,
          centers,
          rawOpponents,
          rawAllies,
          tier.radiusFeet,
        );
        readyTierScalingAreaSpells.push({
          id: spell.id,
          slug: `${spell.slug}-${tier.cost}action`,
          label: `${spell.name} (${tier.cost} action${tier.cost > 1 ? "s" : ""})`,
          cost: tier.cost,
          save: spell.system.defense.save.statistic,
          basic: spell.system.defense.save.basic,
          entryId: entry.id,
          placements,
        });
      }
    }
  }

  // One entry per (spell, tier) pair for a #176-scoped auto-hit-at-max-
  // tier area spell — same geometry pattern as readyTierScalingAreaSpells
  // above (opponent-centered placements, since Force Rain's tiers are all
  // burst/square, never a self-centered emanation), but each tier also
  // carries noSave/flatDamage/damageType so the candidate (and later,
  // execution) knows whether to roll a save at all.
  // A `square` area (Force Rain's own shape) isn't a burst/emanation circle
  // approximated by a bounding square — it genuinely is a square footprint
  // — so #150's real-geometry fix doesn't apply here; it keeps the
  // Chebyshev-square check (`resolveAutoHitAreaTiers` already sets its
  // `radiusFeet` to 0 for that case, matching that pre-existing
  // approximation exactly).
  const readyAutoHitAreaSpells = [];
  for (const entry of combatant.actor?.spellcasting?.contents ?? []) {
    for (const spell of (entry.spells?.contents ?? [])
      .filter(isAutoHitAreaSpellInScope)
      .filter(hasSpellUsesRemaining)
      .filter((spell) => hasSpellSlotRemaining(spell, entry))) {
      const tiers = resolveAutoHitAreaTiers(spell);
      const isSquare = spell.system.area.type === "square";
      const centers =
        spell.system.area.type === "emanation"
          ? [
              {
                centerType: "self",
                centerId: null,
                originToken: combatant.token,
              },
            ]
          : rawOpponents.map((o) => ({
              centerType: "opponent",
              centerId: o.id,
              originToken: o.token,
            }));
      for (const tier of Object.values(tiers)) {
        let placements;
        if (isSquare) {
          const radiusSquares = tier.radiusFeet / gridDistanceFt;
          const withinRadiusOf = (pool) => (centerToken) =>
            pool
              .filter(
                (o) =>
                  chebyshevSquares(centerToken, o.token, gridSize) <=
                  radiusSquares,
              )
              .map((o) => ({ id: o.id, name: o.name }));
          const withinRadius = withinRadiusOf(rawOpponents);
          const withinRadiusAllies = withinRadiusOf(rawAllies);
          placements = rawOpponents.map((center) => ({
            centerType: "opponent",
            centerId: center.id,
            affected: withinRadius(center.token),
            affectedAllies: withinRadiusAllies(center.token),
          }));
        } else {
          placements = await computeAreaPlacements(
            combat,
            centers,
            rawOpponents,
            rawAllies,
            tier.radiusFeet,
          );
        }
        readyAutoHitAreaSpells.push({
          id: spell.id,
          slug: `${spell.slug}-${tier.cost}action`,
          label: `${spell.name} (${tier.cost} action${tier.cost > 1 ? "s" : ""})`,
          cost: tier.cost,
          save: tier.noSave ? null : spell.system.defense.save.statistic,
          basic: tier.noSave ? null : spell.system.defense.save.basic,
          noSave: tier.noSave,
          entryId: entry.id,
          placements,
        });
      }
    }
  }

  const readyAttackSpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isAttackSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const rangeSquares = spellRangeSquares(spell, gridDistanceFt);
          if (rangeSquares == null) return null;
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            cost: Number(spell.system.time.value),
            rangeSquares,
            entryId: entry.id,
          };
        }),
    )
    .filter(Boolean);

  const readyDebuffSpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isDebuffSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const rangeSquares = spellRangeSquares(spell, gridDistanceFt);
          if (rangeSquares == null) return null;
          const conditionsByOutcome = parseConditionsByOutcome(
            spell.system.description?.value ?? "",
          );
          if (!Object.keys(conditionsByOutcome).length) return null;
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            cost: Number(spell.system.time.value),
            rangeSquares,
            save: spell.system.defense.save.statistic,
            entryId: entry.id,
            conditionsByOutcome,
          };
        }),
    )
    .filter(Boolean);

  const readyChainSpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isChainSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const rangeSquares = spellRangeSquares(spell, gridDistanceFt);
          if (rangeSquares == null) return null;
          const hopDistanceFeet = parseChainHopDistance(
            spell.system.description?.value ?? "",
          );
          const hopDistanceSquares = hopDistanceFeet / gridDistanceFt;
          // Opponent-to-opponent hop adjacency only — allies are never
          // included, so the greedy chain walk in buildChainSpellCandidates
          // can never hop into one (the agreed ally-avoidance approach).
          const chainGraph = {};
          for (const from of rawOpponents) {
            chainGraph[from.id] = rawOpponents
              .filter((to) => to.id !== from.id)
              .map((to) => ({
                id: to.id,
                name: to.name,
                distanceSquares: chebyshevSquares(
                  from.token,
                  to.token,
                  gridSize,
                ),
                // #91: a chain hop is still a bolt arcing to the next
                // creature — it can't jump through a wall any more than a
                // direct shot at the primary target could.
                hasLineOfSight: hasLineOfSight(combat, from.token, to.token),
              }))
              .filter(
                (o) =>
                  o.distanceSquares <= hopDistanceSquares && o.hasLineOfSight,
              )
              .map(({ id, name, distanceSquares }) => ({
                id,
                name,
                distanceSquares,
              }));
          }
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            cost: Number(spell.system.time.value),
            rangeSquares,
            save: spell.system.defense.save.statistic,
            basic: spell.system.defense.save.basic,
            entryId: entry.id,
            chainGraph,
          };
        }),
    )
    .filter(Boolean);

  const readyHealSpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isHealSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const rangeSquares = healSpellRangeSquares(spell, gridDistanceFt);
          if (rangeSquares == null) return null;
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            cost: healSpellCost(spell),
            rangeSquares,
            entryId: entry.id,
          };
        }),
    )
    .filter(Boolean);

  const readyBuffSpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isBuffSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const rangeSquares = spellRangeSquares(spell, gridDistanceFt);
          if (rangeSquares == null) return null;
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            cost: Number(spell.system.time.value),
            rangeSquares,
            entryId: entry.id,
          };
        }),
    )
    .filter(Boolean);

  // One entry per #174-scoped dual-nature tiered spell (Harm/Heal-shaped).
  // Unlike every other ready-spell block, this one draws from BOTH
  // rawOpponents and rawAllies for every tier, since which pool a target
  // is valid FROM depends on the effect it would receive, not on the
  // spell's usual "opponents only" or "allies only" convention: the
  // harm-direction effect only ever targets opponents (never harm an
  // ally), the heal-direction effect only ever targets allies at the
  // single-target tiers (never heal an opponent) - confirmed live via
  // isUndeadCombatant/dualNatureHarmfulTrait's polarity split - but the
  // 3-action area tier hits BOTH pools without discrimination by
  // allegiance at all, per the spell's own text ("targets all living and
  // undead creatures in the area", no willingness/allegiance
  // qualifier there unlike the single-target tiers' "willing undead
  // creature" phrasing) - a real, deliberate risk/reward tradeoff RAW
  // itself describes, not a gap in this module's own targeting logic.
  const isUndeadCombatant = (c) =>
    c.actor?.system?.traits?.value?.includes("undead") ?? false;
  const isBelowMaxHp = (c) =>
    (c.actor?.system?.attributes?.hp?.value ?? 0) <
    (c.actor?.system?.attributes?.hp?.max ?? 0);

  const readyDualNatureSpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isDualNatureTieredSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const tiers = parseActionGlyphTiers(
            spell.system.description?.value ?? "",
          );
          const harmfulTrait = dualNatureHarmfulTrait(spell);
          const polarity = (c) =>
            isUndeadCombatant(c) === (harmfulTrait === "undead")
              ? "harm"
              : "heal";

          const singleTargetTiers = [];
          for (const cost of [1, 2]) {
            const tier = tiers[cost];
            if (!tier || tier.area != null || tier.rangeFeet == null) continue;
            const rangeSquares =
              tier.rangeFeet === "touch"
                ? MELEE_REACH_SQUARES
                : tier.rangeFeet / gridDistanceFt;
            const harmTargets = rawOpponents
              .filter(
                (o) =>
                  polarity(o) === "harm" &&
                  chebyshevSquares(combatant.token, o.token, gridSize) <=
                    rangeSquares &&
                  // #91: the harm-direction effect is a single-target
                  // ranged/touch spell like any other attack spell here —
                  // it needs the same wall check.
                  canSee(o),
              )
              .map((o) => ({ id: o.id, name: o.name }));
            const healTargets = rawAllies
              .filter(
                (a) =>
                  polarity(a) === "heal" &&
                  isBelowMaxHp(a) &&
                  chebyshevSquares(combatant.token, a.token, gridSize) <=
                    rangeSquares,
              )
              .map((a) => ({ id: a.id, name: a.name }));
            singleTargetTiers.push({
              cost,
              bonus: tier.bonus ?? 0,
              harmTargets,
              healTargets,
            });
          }

          let areaTier = null;
          const areaTierRaw = tiers[3];
          if (areaTierRaw?.area) {
            const radiusSquares = areaTierRaw.area.value / gridDistanceFt;
            const allNearby = [...rawOpponents, ...rawAllies].filter(
              (c) =>
                chebyshevSquares(combatant.token, c.token, gridSize) <=
                radiusSquares,
            );
            const harmTargets = allNearby
              .filter((c) => polarity(c) === "harm")
              .map((c) => ({ id: c.id, name: c.name }));
            const healTargets = allNearby
              .filter((c) => polarity(c) === "heal" && isBelowMaxHp(c))
              .map((c) => ({ id: c.id, name: c.name }));
            areaTier = { cost: areaTierRaw.cost, harmTargets, healTargets };
          }

          if (!singleTargetTiers.length && !areaTier) return null;
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            entryId: entry.id,
            save: spell.system.defense.save.statistic,
            basic: spell.system.defense.save.basic,
            singleTargetTiers,
            areaTier,
          };
        }),
    )
    .filter(Boolean);

  // One entry per #175-scoped target-count-scaling spell (Rebuke Death-
  // shaped) - each tier's own targets are pre-selected here (in range, not
  // already at full HP, neediest-first by current HP - per live
  // discussion) so the pure candidate builder only ever packages what it's
  // given, matching every other tier-scaling spell in this file. A
  // healing-trait spell only ever draws from allies (never heal an
  // opponent, matching #132/#174's established restriction); a
  // hypothetical non-healing target-count spell (no real example exists
  // today, but the scope filter doesn't assume healing) would draw from
  // opponents instead, matching #118's damage-spell convention.
  const readyTargetCountSpells = (combatant.actor?.spellcasting?.contents ?? [])
    .flatMap((entry) =>
      (entry.spells?.contents ?? [])
        .filter(isTargetCountSpellInScope)
        .filter(hasSpellUsesRemaining)
        .filter((spell) => hasSpellSlotRemaining(spell, entry))
        .map((spell) => {
          const formula = parseTargetCountFormula(
            spell.system.target?.value ?? "",
          );
          const timeMatch = /^([123])\s+to\s+([123])$/.exec(
            spell.system.time?.value ?? "",
          );
          const minCost = Number(timeMatch[1]);
          const maxCost = Number(timeMatch[2]);
          const rangeSquares = (spell.system.area?.value ?? 0) / gridDistanceFt;
          const isHealing =
            spell.system.traits?.value?.includes("healing") ?? false;
          const pool = isHealing ? rawAllies : rawOpponents;
          const inRange = pool
            .filter(
              (c) =>
                chebyshevSquares(combatant.token, c.token, gridSize) <=
                rangeSquares,
            )
            // #91: only ever gates the opponent-facing (damage) pool — a
            // heal-direction target-count spell still targets allies
            // unconditionally, matching this file's existing, deliberate
            // choice not to require a wall check for ally-targeting heal/
            // buff spells (see hasLineOfSight's own callers above).
            .filter((c) => isHealing || canSee(c))
            .filter(
              (c) =>
                !isHealing ||
                (c.actor?.system?.attributes?.hp?.value ?? 0) <
                  (c.actor?.system?.attributes?.hp?.max ?? 0),
            )
            .sort(
              (a, b) =>
                (a.actor?.system?.attributes?.hp?.value ?? 0) -
                (b.actor?.system?.attributes?.hp?.value ?? 0),
            );
          const tiers = [];
          for (let cost = minCost; cost <= maxCost; cost++) {
            const maxTargets = Math.floor(formula.countPerAction * cost);
            tiers.push({
              cost,
              targets: inRange
                .slice(0, maxTargets)
                .map((c) => ({ id: c.id, name: c.name })),
            });
          }
          return {
            id: spell.id,
            slug: spell.slug,
            label: spell.name,
            entryId: entry.id,
            save: spell.system.defense?.save?.statistic ?? null,
            basic: spell.system.defense?.save?.basic ?? null,
            tiers,
          };
        }),
    )
    .filter(Boolean);

  const readyBreathWeapons = [];
  for (const item of combatant.actor?.items ?? []) {
    if (!isBreathWeaponInScope(item)) continue;
    const slug = actionItemSlug(item);
    if (!isAbilityRecharged(combat, combatant.id, slug)) continue;
    const effect = parseBreathWeaponEffect(
      item.system.description?.value ?? "",
    );
    const placements = await computeConePlacements(
      combat,
      combatant.token,
      rawOpponents,
      effect.distanceFeet,
    );
    readyBreathWeapons.push({
      itemId: item.id,
      slug,
      label: item.name,
      cost: item.system.actions.value,
      damageFormula: effect.damageFormula,
      damageType: effect.damageType,
      save: effect.save,
      dc: effect.dc,
      rechargeFormula: effect.rechargeFormula,
      placements,
    });
  }

  const readyMultiStrikeBundles = [];
  for (const item of combatant.actor?.items ?? []) {
    if (!isMultiStrikeBundleInScope(item)) continue;
    const parsed = parseMultiStrikeBundle(item.system.description?.value ?? "");
    const strikes = [];
    let reachSquares = Infinity;
    let allMatched = true;
    for (const { count, name } of parsed) {
      const matched = matchMultiStrikeActionSlug(name, readyActions);
      if (!matched) {
        allMatched = false;
        break;
      }
      strikes.push({ actionSlug: matched.slug, count });
      reachSquares = Math.min(reachSquares, matched.reachSquares);
    }
    if (!allMatched) continue;
    readyMultiStrikeBundles.push({
      itemId: item.id,
      slug: actionItemSlug(item),
      label: item.name,
      cost: item.system.actions.value,
      strikes,
      reachSquares,
    });
  }

  const self = {
    name: combatant.name,
    hp: combatant.actor?.system?.attributes?.hp?.value ?? null,
    conditions: Array.from(combatant.actor?.conditions ?? []).map(
      (c) => c.slug,
    ),
  };

  const seekTargets = seekableSneakerIds(combat, combatant).map((id) => ({
    id,
    name: combat.combatants.find((c) => c.id === id)?.name ?? id,
  }));
  const candidates = buildCandidateList({
    seekTargets,
    opponents,
    readyActions,
    readySpells: [...readySpells, ...readyVariableCostSpells],
    readyAreaSpells,
    readyAttackSpells,
    readyDebuffSpells,
    readyBreathWeapons,
    readyMultiStrikeBundles,
    readyChainSpells,
    readyHealSpells,
    readyBuffSpells,
    readyTierScalingAreaSpells,
    readyDualNatureSpells,
    readyTargetCountSpells,
    readyAutoHitAreaSpells,
    allies,
    turnState,
    maneuverVocabulary,
    maneuverPicks: turnState.maneuverPicks,
    featVocabulary,
    npcAbilityVocabulary,
    npcMoveVocabulary,
    npcStrikeVocabulary,
    npcSelfVocabulary,
    hazard: nearestHazardousRegionPoint(
      combat.scene,
      combatant.token,
      gridSize,
    ),
    hasRangedOrReach,
  });
  return {
    combatId: combat.id,
    combatantId: combatant.id,
    context: buildDecisionContext({
      self,
      opponents,
      allies,
      candidates,
      roundNumber: combat.round,
    }),
    candidates,
    maneuverVocabulary,
    featVocabulary,
    npcAbilityVocabulary,
    npcMoveVocabulary,
    npcStrikeVocabulary,
    npcSelfVocabulary,
  };
}

/** #915: getPendingAgentTurn's NPC-ability vocabulary -- readiness from
 * computeReadyNpcAbilities, then real template placements for each area
 * ability: an emanation is one self-centered placement; a cone uses the
 * breath-weapon cone placements; a burst is centered on each visible
 * opponent within its stated range (the area spells' own burst
 * convention). Any other shape (line, ...) has no placement helper and is
 * not offered. */
async function computeNpcAbilityVocabulary(
  combat,
  combatant,
  rawOpponents,
  rawAllies,
  opponents,
  actionsRemaining,
  gridSize,
) {
  const { readyAreaAbilities: rawArea, readySingleTargetAbilities } =
    computeReadyNpcAbilities(combat, combatant, [...rawOpponents, ...rawAllies]);
  const readyAreaAbilities = [];
  for (const ability of rawArea) {
    if (ability.cost > actionsRemaining) continue;
    let placements;
    if (ability.areaType === "emanation") {
      placements = await computeAreaPlacements(
        combat,
        [{ centerType: "self", centerId: null, originToken: combatant.token }],
        rawOpponents,
        rawAllies,
        ability.distanceFeet,
      );
    } else if (ability.areaType === "cone") {
      placements = await computeConePlacements(
        combat,
        combatant.token,
        rawOpponents,
        ability.distanceFeet,
        rawAllies,
      );
    } else if (ability.areaType === "burst" && ability.rangeFeet) {
      const rangeSquares = Math.floor(ability.rangeFeet / 5);
      const centers = rawOpponents
        .filter(
          (o) =>
            chebyshevSquares(combatant.token, o.token, gridSize) <= rangeSquares &&
            hasLineOfSight(combat, combatant.token, o.token),
        )
        .map((o) => ({ centerType: "opponent", centerId: o.id, originToken: o.token }));
      placements = await computeAreaPlacements(
        combat,
        centers,
        rawOpponents,
        rawAllies,
        ability.distanceFeet,
      );
    } else {
      continue;
    }
    readyAreaAbilities.push({ ...ability, placements });
  }
  return buildNpcAbilityVocabulary({
    readyAreaAbilities,
    readySingleTargetAbilities,
    opponents,
    actionsRemaining,
  });
}

/** Moves `combatant`'s token up to its own speed, along a real, wall-aware
 * path (#100) toward or away from `target`'s token depending on `posture`.
 * For `approach`, stops adjacent to the target rather than overshooting past
 * it — the same clamp stepToward uses. `retreat` has no "don't overshoot"
 * concept, so it's unclamped, bounded only by speed and posturePath's own
 * progressively-shorter-distance fallback. A no-op beyond `snapTokenToGrid`'s
 * own possible correction (#86) if already at the desired distance, with no
 * speed to move, or if no usable path exists. */
export async function strideByPosture(combat, combatant, posture, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const preSnap = rawPosition(combatant.token);
  await snapTokenToGrid(combatant.token, gridSize);
  const preReported = await reportPreMoveOverlap(
    "strideByPosture",
    combat,
    combatant,
    preSnap,
    gridSize,
    target,
  );
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0 || !target) return "no-speed";

  const plan = planPostureWalk(combat, combatant, posture, target, speedSquares);
  if (plan.status !== "ok") return plan.status;
  // #933: RAW, moving ends a grab the mover holds.
  if (plan.waypoint.steps?.length) await releaseGrab(combat, combatant);
  // #931: Twisting Tail / Wing Rebuff fire mid-move and can stop it.
  const walk = await walkWithMoveReactions(combat, combatant, plan.start, plan.waypoint.steps, gridSize);
  if (!preReported && !walk.disrupted)
  await reportMoveOverlap({
    combat,
    combatant,
    kind: "strideByPosture",
    posture,
    targetCombatant: target,
    startCell: plan.start,
    goalCell: plan.targetCell,
    path: plan.path,
    steps: plan.waypoint.steps,
    occupantsSnapshot: plan.occupants,
    speedSquares,
    stopWithin: plan.stopWithin,
    gridSize,
  });
  await offerReactiveStrikesAgainst(combat, combatant, { trigger: "strideEnd" });
  return walk.disrupted ? "disrupted" : "moved";
}

/**
 * The route half of a posture move (strideByPosture, #932's movement
 * abilities): a real, wall-aware path from `combatant`'s cell toward
 * (`approach`) or away from (`retreat`/`reposition`) `target`, walked up to
 * `speedSquares` -- an approach stops at melee reach, and falls back to
 * `fallbackLanding` when every cell on the shortest path is taken (#606).
 * `straightLine` (Eagle Dive, Sprint: "in a straight line") walks one
 * straight grid line instead of a pathfound route. Moves nothing. Returns
 * `{ status: "ok"|"no-route"|"blocked", start, targetCell, path, waypoint,
 * occupants, stopWithin }`.
 */
function planPostureWalk(combat, combatant, posture, target, speedSquares, { straightLine = false } = {}) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const me = combatant.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const targetCell = tokenCell(target.token, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(
    combat,
    combatant,
    posture === "approach" ? targetCell : null,
  );
  const stopWithin = posture === "approach" ? MELEE_REACH_SQUARES : 0;
  const base = { start, targetCell, stopWithin };
  if (straightLine) {
    const occupants = otherCombatantFootprints(combat, combatant, gridSize);
    const waypoint = straightLineWalk(start, targetCell, posture, speedSquares, stopWithin, isBlocked, bounds, occupants, moverFootprint);
    if (!waypoint) return { ...base, status: "blocked", path: null, waypoint: null, occupants };
    return { ...base, status: "ok", path: [start, ...waypoint.steps], waypoint, occupants };
  }
  const path = posturePath(
    start,
    targetCell,
    posture,
    speedSquares,
    isBlocked,
    bounds,
    moverFootprint,
  );
  if (!path) return { ...base, status: "no-route", path: null, waypoint: null, occupants: [] };

  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const waypoint = walkPath(
    path,
    targetCell,
    speedSquares,
    stopWithin,
    occupants,
    moverFootprint,
  ) ??
    (posture === "approach"
      ? fallbackLanding(
          start,
          targetCell,
          speedSquares,
          stopWithin,
          isBlocked,
          bounds,
          occupants,
          moverFootprint,
        )
      : null);
  if (!waypoint) return { ...base, status: "blocked", path, waypoint: null, occupants };
  return { ...base, status: "ok", path, waypoint, occupants };
}

/**
 * #932: "in a straight line" (Eagle Dive, Sprint) -- the grid line from
 * `start` toward `targetCell` (approach) or directly away from it
 * (retreat), walked square by square until the budget runs out, a wall or
 * hostile blocks the next step, the scene ends, or (approach) the next
 * square would go inside `stopWithin` of the target. Lands on the last
 * unoccupied square reached. Returns `{cell, steps}` like walkPath, or null.
 */
function straightLineWalk(start, targetCell, posture, speedSquares, stopWithin, isBlocked, bounds, occupants, moverFootprint) {
  const cheb = (a, b) => Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy));
  const sign = posture === "approach" ? 1 : -1;
  const dx = sign * (targetCell.gx - start.gx);
  const dy = sign * (targetCell.gy - start.gy);
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  if (n === 0) return null;
  const line = [];
  let prev = start;
  for (let k = 1; k <= speedSquares; k += 1) {
    const cell = { gx: start.gx + Math.round((dx * k) / n), gy: start.gy + Math.round((dy * k) / n) };
    if (bounds && (cell.gx < bounds.gx0 || cell.gy < bounds.gy0 ||
      cell.gx + moverFootprint.gw - 1 > bounds.gx1 || cell.gy + moverFootprint.gh - 1 > bounds.gy1)) break;
    if (stopWithin > 0 && cheb(cell, targetCell) < stopWithin) break;
    if (isBlocked(prev, cell)) break;
    line.push(cell);
    prev = cell;
  }
  let landing = -1;
  line.forEach((cell, i) => {
    if (!cellOccupied(cell, occupants, moverFootprint)) landing = i;
  });
  return landing >= 0 ? { cell: line[landing], steps: line.slice(0, landing + 1) } : null;
}

// ---------------------------------------------------------------------------
// #932: NPC movement abilities (Gallop, Swift Leap, Swoop, Eagle Dive, Rush,
// Phase Jump, ...). npc-move-parse.mjs recognizes the ability; this section
// owns the geometry: which (posture, target) pairs are really possible right
// now, and executing one. Movement reuses the posture planner above (the
// same wall/occupancy-aware route a Stride takes); alternate movement types
// (Fly, Swim, Burrow, Climb) use the same 2-D pathing with that type's Speed
// -- elevation and mode-specific terrain are not modeled (#973).

const NPC_MOVE_MODES = ["land", "fly", "swim", "burrow", "climb"];
const NPC_MOVE_MODE_LABEL = { land: "land", fly: "fly", swim: "swim", burrow: "burrow", climb: "climb" };

/** The mover's Speeds in feet by movement type -- the system's own
 * `system.movement.speeds[type].value` (pf2e 8.5.0 leaves a type the
 * creature lacks `null`). Types without a positive Speed are omitted. */
function moverSpeedsOf(actor) {
  const speeds = actor?.system?.movement?.speeds ?? {};
  const out = {};
  for (const mode of NPC_MOVE_MODES) {
    const value = Number(speeds[mode]?.value ?? 0);
    if (value > 0) out[mode] = value;
  }
  return out;
}

/** `cell` as a token-shaped position for `token` (footprint-aware). */
function positionAt(cell, token, gridSize) {
  return {
    x: cell.gx * gridSize,
    y: cell.gy * gridSize,
    width: token?.width ?? 1,
    height: token?.height ?? 1,
  };
}

/** The ready melee Strikes a movement ability's Strike may use: the named
 * limb(s) ("talon", "beak or talon"), or every ready melee Strike when the
 * text names none ("makes a Strike", "makes a melee Strike"). */
function npcMoveStrikeActions(actor, limbs, gridDistanceFt) {
  const melee = readyMeleeStrikeActions(actor).map((a) => ({
    slug: a.item?.slug ?? a.slug ?? a.label,
    label: a.label,
    reachSquares: actionReachSquares(a, gridDistanceFt),
  }));
  if (!limbs?.length) return melee;
  const out = [];
  for (const limb of limbs) {
    const matched = matchMultiStrikeActionSlug(limb, melee);
    if (matched && !out.includes(matched)) out.push(matched);
  }
  return out;
}

/** The first of `actions` that can hit `target` with `mover` standing on
 * `cell`: in reach (footprint-aware) and a clear line (#91), or null. */
function npcMoveStrikeFrom(combat, mover, target, cell, actions, gridSize) {
  if (!target?.token) return null;
  const position = positionAt(cell, mover.token, gridSize);
  const distance = chebyshevSquares(position, target.token, gridSize);
  const action = actions.find((a) => distance <= a.reachSquares + REACH_EPSILON);
  if (!action) return null;
  return hasLineOfSight(combat, position, target.token) ? action : null;
}

/**
 * #932: a teleport destination for `combatant` within `rangeSquares` of its
 * own square, or null. PF2e's teleportation needs no path, so walls between
 * don't matter for the move itself, but the destination must be a free
 * square (no creature or living cover) the creature can see from where it
 * stands -- this module's conservative reading, which also keeps it inside
 * the explored map. `next-to`: a square adjacent to `target` (with a clear
 * line to it), the shortest jump first; not offered when already adjacent.
 * `away-from`: the square farthest from `target` (strictly farther than now),
 * then the shortest jump. Ties break on the straightest jump, then grid
 * position, so the choice is deterministic.
 */
function planNpcTeleport(combat, combatant, posture, target, rangeSquares) {
  if (!target?.token || !(rangeSquares > 0)) return null;
  const gridSize = combat.scene?.grid?.size ?? 100;
  const me = combatant.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const targetCell = tokenCell(target.token, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const current = chebyshevSquares(me, target.token, gridSize);
  if (posture === "next-to" && current <= MELEE_REACH_SQUARES) return null;
  if (posture !== "next-to" && posture !== "away-from") return null;
  const candidates = [];
  for (let dx = -rangeSquares; dx <= rangeSquares; dx += 1) {
    for (let dy = -rangeSquares; dy <= rangeSquares; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      const cell = { gx: start.gx + dx, gy: start.gy + dy };
      if (
        bounds &&
        (cell.gx < bounds.gx0 || cell.gy < bounds.gy0 ||
          cell.gx + moverFootprint.gw - 1 > bounds.gx1 ||
          cell.gy + moverFootprint.gh - 1 > bounds.gy1)
      )
        continue;
      const distance = chebyshevSquares(positionAt(cell, me, gridSize), target.token, gridSize);
      if (posture === "next-to" ? distance > MELEE_REACH_SQUARES : distance <= current) continue;
      if (cellOccupied(cell, occupants, moverFootprint)) continue;
      const jump = Math.max(Math.abs(dx), Math.abs(dy));
      const straightness = dx * dx + dy * dy;
      const key = posture === "next-to"
        ? [jump, straightness, cell.gy, cell.gx]
        : [-distance, jump, straightness, cell.gy, cell.gx];
      candidates.push({ cell, key });
    }
  }
  candidates.sort((a, b) => {
    for (let i = 0; i < a.key.length; i += 1) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return 0;
  });
  const walls = sceneWallBlockedEdges(combat);
  for (const { cell } of candidates) {
    if (!sightLineClear(start, cell, walls)) continue;
    if (posture === "next-to" && !sightLineClear(cell, targetCell, walls)) continue;
    return cell;
  }
  return null;
}

/**
 * #932: plans one use of a parsed movement ability (`descriptor`, from
 * parseMovementAbility) against `target` in `posture`, moving nothing.
 * Returns `{ ok: false, reason }` or `{ ok: true, kind, ... }`:
 *  - `teleport`: `{ cell }` (planNpcTeleport).
 *  - `move` (`approach`/`retreat`): `{ budget, walk }` -- planPostureWalk
 *    with the ability's own budget (npcMoveBudget: the best usable Speed
 *    among its movement types, factor, per-move bonus, repeats).
 *  - `strike` (`approach`, or `hitAndRun` for a Strike "at any point during
 *    that movement"): `{ budget, start, steps, action, retreatSquares }` --
 *    walk `steps`, Strike with `action`, then (hitAndRun) move away with the
 *    `retreatSquares` left. A Strike "at the end of that movement" needs the
 *    whole move to end in reach; "at any point" Strikes from the first free
 *    square in reach. An approach that already starts in reach is not
 *    offered (that is a plain Strike).
 */
function planNpcMove(combat, combatant, descriptor, posture, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const plan = descriptor?.plan;
  if (!plan || !target?.token) return { ok: false, reason: "no-target" };
  if (plan.kind === "teleport") {
    const cell = planNpcTeleport(combat, combatant, posture, target, Math.floor(plan.teleportFeet / gridDistanceFt));
    return cell ? { ok: true, kind: "teleport", cell } : { ok: false, reason: "no-destination" };
  }
  const budget = npcMoveBudget(plan, moverSpeedsOf(combatant.actor), gridDistanceFt);
  if (!budget) return { ok: false, reason: "no-speed" };
  if (!plan.strike) {
    if (posture !== "approach" && posture !== "retreat") return { ok: false, reason: "posture" };
    const walk = planPostureWalk(combat, combatant, posture, target, budget.squares, { straightLine: plan.straightLine });
    return walk.status === "ok" ? { ok: true, kind: "move", budget, walk } : { ok: false, reason: walk.status };
  }

  if (posture !== "approach" && !(posture === "hitAndRun" && plan.strike.timing === "any")) {
    return { ok: false, reason: "posture" };
  }
  const actions = npcMoveStrikeActions(combatant.actor, plan.strike.limbs, gridDistanceFt);
  if (!actions.length) return { ok: false, reason: "no-ready-strike" };
  const start = tokenCell(combatant.token, gridSize);
  const atStart = npcMoveStrikeFrom(combat, combatant, target, start, actions, gridSize);
  if (posture === "approach" && atStart) return { ok: false, reason: "already-in-reach" };
  if (atStart) {
    return { ok: true, kind: "strike", budget, start, steps: [], action: atStart, retreatSquares: budget.squares };
  }
  const walk = planPostureWalk(combat, combatant, "approach", target, budget.squares, { straightLine: plan.straightLine });
  if (walk.status !== "ok") return { ok: false, reason: walk.status };
  const steps = walk.waypoint.steps;
  if (plan.strike.timing === "end") {
    const action = npcMoveStrikeFrom(combat, combatant, target, steps.at(-1) ?? start, actions, gridSize);
    if (!action) return { ok: false, reason: "out-of-reach" };
    return { ok: true, kind: "strike", budget, start, steps, action, retreatSquares: 0 };
  }
  const moverFootprint = footprint(combatant.token, gridSize);
  for (let i = 0; i < steps.length; i += 1) {
    if (cellOccupied(steps[i], walk.occupants, moverFootprint)) continue;
    const action = npcMoveStrikeFrom(combat, combatant, target, steps[i], actions, gridSize);
    if (!action) continue;
    const retreatSquares = posture === "hitAndRun" ? budget.squares - (i + 1) : 0;
    if (posture === "hitAndRun" && retreatSquares <= 0) return { ok: false, reason: "no-budget" };
    return { ok: true, kind: "strike", budget, start, steps: steps.slice(0, i + 1), action, retreatSquares };
  }
  return { ok: false, reason: "out-of-reach" };
}

/**
 * #932: the movement abilities `combatant` (an NPC) can use right now, as
 * buildNpcMoveVocabulary's entries: parsed (npc-move-parse.mjs), affordable
 * this turn, with frequency uses left and off recharge (the same
 * name-derived slug and `abilityRecharge` store breath weapons and #915's
 * abilities use), and with a Speed for one of its movement types. A
 * move-plus-Strike or teleport entry carries the (posture, target) pairs
 * planNpcMove found really possible against `targets`; a plain move's
 * postures are chosen by the builder.
 */
export function computeNpcMoveEntries(combat, combatant, targets, actionsRemaining) {
  const actor = combatant?.actor;
  if (actor?.type !== "npc") return [];
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speeds = moverSpeedsOf(actor);
  const entries = [];
  for (const item of actorActionItems(actor)) {
    const descriptor = parseMovementAbility(item);
    if (!descriptor) continue;
    if (descriptor.cost > actionsRemaining) continue;
    const uses = descriptor.frequency?.value;
    if (descriptor.frequency && !(typeof uses === "number" && uses > 0)) continue;
    const slug = actionItemSlug(item);
    if (!isAbilityRecharged(combat, combatant.id, slug)) continue;
    const { plan } = descriptor;
    const base = { itemId: item.id, slug, name: item.name, cost: descriptor.cost, traits: featGatingTraits(item), plan };
    if (plan.kind === "teleport") {
      const teleportOptions = [];
      for (const target of targets) {
        for (const posture of ["next-to", "away-from"]) {
          if (planNpcMove(combat, combatant, descriptor, posture, target).ok) {
            teleportOptions.push({ posture, targetId: target.id });
          }
        }
      }
      if (teleportOptions.length) entries.push({ ...base, kind: "teleport", teleportOptions });
      continue;
    }
    const budget = npcMoveBudget(plan, speeds, gridDistanceFt);
    if (!budget) continue;
    const movement = { mode: budget.mode, feet: budget.feet, speedSquares: budget.squares };
    if (!plan.strike) {
      entries.push({ ...base, kind: "move", ...movement });
      continue;
    }
    const postures = plan.strike.timing === "any" ? ["approach", "hitAndRun"] : ["approach"];
    const strikeOptions = [];
    for (const target of targets) {
      for (const posture of postures) {
        if (planNpcMove(combat, combatant, descriptor, posture, target).ok) {
          strikeOptions.push({ posture, targetId: target.id });
        }
      }
    }
    if (strikeOptions.length) entries.push({ ...base, kind: "strike", ...movement, strikeOptions });
  }
  return entries;
}

/**
 * #932: walks a movement ability's `steps`. Movement-triggered reactions
 * follow the rules as written (the module owns AI movement, so it can):
 * every reaction a move can trigger -- Reactive Strike when the creature
 * leaves a square within reach (or starts a move action in reach), Twisting
 * Tail, Wing Rebuff -- resolves at the square it fires on, and a disrupting
 * one ends the move there. This is the `move` trigger a player's own drag
 * uses (#931), not the generic Stride's end-of-move check. A "doesn't
 * trigger reactions" ability (Swift Leap) walks with no reaction check at
 * all. Returns `{ disrupted }`.
 */
async function walkNpcMoveSteps(combat, mover, startCell, steps, gridSize, { suppressReactions = false } = {}) {
  if (!steps?.length) return { disrupted: false };
  if (suppressReactions) {
    await walkTokenThroughSteps(mover.token, steps, gridSize);
    return { disrupted: false };
  }
  return walkWithMoveReactions(combat, mover, startCell, steps, gridSize, new Set(), { onlyDisrupting: false });
}

/** #932: the GM-only notes for a movement ability's use -- what this module
 * did not model (elevation, a non-land movement type's terrain rules). */
function npcMoveGmNote(plan, budget) {
  const lines = [];
  if (budget?.mode && budget.mode !== "land") {
    lines.push(`Used its ${NPC_MOVE_MODE_LABEL[budget.mode]} Speed on 2-D pathing; elevation and ${NPC_MOVE_MODE_LABEL[budget.mode]} terrain rules are not modeled.`);
  }
  if (plan?.elevationNote) lines.push(`The ability requires ${plan.elevationNote}; elevation is not modeled.`);
  if (plan?.suppressReactions) lines.push("This movement triggers no reactions.");
  if (plan?.kind === "teleport") lines.push("Teleportation: no movement reactions.");
  return lines.length ? lines.join("\n") : null;
}

/**
 * #932: executes a chosen movement ability. Re-resolves the item, its
 * parse, the target and the whole plan from the current board (the
 * "re-resolve at execution time" rule every executor follows); when nothing
 * is possible any more it returns `{ performed: false }` before spending
 * anything. Otherwise it spends a frequency use and the recharge (as the
 * system's own use-action card does), posts the ability card, then:
 *  - teleport: moves the token straight to the planned square
 *    (`displace`, no path -- teleportation triggers no movement reactions);
 *  - move: walks the planned route (walkNpcMoveSteps);
 *  - strike: walks to the Strike point, Strikes at the turn's current MAP
 *    if the target is still in reach (a reaction may have moved either
 *    creature), then -- hitAndRun -- moves away with the budget left. A
 *    disrupted move ends the activity: no Strike.
 * Returns `{ performed, moveStatus, attacks, strikeOutcomes, strikeSkipped,
 * gmNote }` for the AI turn card.
 */
async function executeNpcMoveCandidate(combat, combatant, candidate) {
  const item = actorActionItems(combatant.actor).find((i) => i.id === candidate.itemId);
  const descriptor = item ? parseMovementAbility(item) : null;
  if (!descriptor) return { performed: false };
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return { performed: false };
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  await snapTokenToGrid(combatant.token, gridSize);
  const planned = planNpcMove(combat, combatant, descriptor, candidate.posture, target);
  if (!planned.ok) return { performed: false, reason: planned.reason };

  const uses = item.system?.frequency?.value;
  if (typeof uses === "number") {
    await item.update({ "system.frequency.value": Math.max(0, uses - 1) });
  }
  await setAbilityRecharge(combat, combatant.id, actionItemSlug(item), descriptor.rechargeFormula);
  try {
    await item.toMessage?.();
  } catch (err) {
    console.error(`${MODULE_ID} | #932: posting ${item.name} failed:`, err.message);
  }
  const { plan } = descriptor;
  const result = { performed: true, moveStatus: "moved", attacks: 0, strikeOutcomes: [], strikeSkipped: null, gmNote: npcMoveGmNote(plan, planned.budget) };
  // #933: RAW, moving (or teleporting) ends a grab the mover holds.
  const moves = planned.kind === "teleport" || planned.kind === "move" || planned.steps?.length > 0 || planned.retreatSquares > 0;
  if (moves) await releaseGrab(combat, combatant);
  const suppressReactions = plan.suppressReactions === true;

  if (planned.kind === "teleport") {
    await combatant.token.move({ x: planned.cell.gx * gridSize, y: planned.cell.gy * gridSize, action: "displace" });
    return { ...result, moveStatus: "teleported" };
  }
  if (planned.kind === "move") {
    const walk = await walkNpcMoveSteps(combat, combatant, planned.walk.start, planned.walk.waypoint.steps, gridSize, { suppressReactions });
    return { ...result, moveStatus: walk.disrupted ? "disrupted" : "moved" };
  }

  const first = await walkNpcMoveSteps(combat, combatant, planned.start, planned.steps, gridSize, { suppressReactions });
  if (first.disrupted || combatant.isDefeated) {
    return { ...result, moveStatus: "disrupted", strikeSkipped: "move disrupted" };
  }
  result.moveStatus = planned.steps.length ? "moved" : "stayed";
  const here = tokenCell(combatant.token, gridSize);
  const actions = npcMoveStrikeActions(combatant.actor, plan.strike.limbs, gridDistanceFt);
  const action = target.isDefeated ? null : npcMoveStrikeFrom(combat, combatant, target, here, actions, gridSize);
  if (!action) return { ...result, strikeSkipped: "target out of reach" };
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const outcome = await rollAndApplyStrikeAtVariant(combat, combatant, target, action.slug, mapIncrement);
  result.attacks = 1;
  result.strikeOutcomes = [outcome ?? null];
  // #933: which Strike hit whom, for Rend's "two consecutive Strikes".
  result.strikeRecords = [{ slug: action.slug, targetId: target.id, outcome: outcome ?? null }];
  if (candidate.posture === "hitAndRun" && planned.retreatSquares > 0 && !combatant.isDefeated && target.token) {
    const away = planPostureWalk(combat, combatant, "retreat", target, planned.retreatSquares, { straightLine: plan.straightLine });
    if (away.status === "ok") {
      const walk = await walkNpcMoveSteps(combat, combatant, away.start, away.waypoint.steps, gridSize, { suppressReactions });
      result.moveStatus = walk.disrupted ? "disrupted" : "moved";
    } else {
      result.retreat = away.status;
    }
  }
  return result;
}

// --- #933: NPC Strike-plus abilities ------------------------------------

const NPC_STRIKE_HIT_TEXT = Object.freeze({
  criticalSuccess: "critical hit",
  success: "hit",
  failure: "miss",
  criticalFailure: "critical miss",
});

/** #933: the Strikes of the current turn and round, in order, as
 * `{ slug, targetId, outcome }` -- Rend's "hit the same enemy with two
 * consecutive Strikes of the listed type in the same round". Kept on its own
 * combat flag (not the per-turn decision state), keyed by combatant and
 * round so a new round or another combatant's turn starts empty. */
function getTurnStrikeLog(combat, combatantId) {
  const stored = combat.getFlag?.(MODULE_ID, "agentStrikeLog");
  if (!stored || stored.combatantId !== combatantId || stored.round !== combat.round) return [];
  return Array.isArray(stored.records) ? stored.records : [];
}

async function appendTurnStrikeLog(combat, combatantId, records) {
  if (!records?.length) return;
  const current = getTurnStrikeLog(combat, combatantId);
  await combat.setFlag(MODULE_ID, "agentStrikeLog", {
    combatantId,
    round: combat.round,
    records: [...current, ...records].slice(-8),
  });
}

/** #933: the Strikes an executed candidate made, for the turn's Strike log.
 * A Strike whose weapon this can't name (a composite feat's) is logged with
 * `slug: null`, which breaks a Rend chain rather than faking one. */
export function strikeRecordsOf(candidate, executionResult) {
  const r = executionResult;
  if (!candidate) return [];
  if (candidate.type === "strike" && typeof r === "string") {
    return [{ slug: candidate.actionSlug, targetId: candidate.targetId, outcome: r }];
  }
  if (candidate.type === "multiStrike" && Array.isArray(r)) {
    return r.map((s) => ({ slug: s?.actionSlug ?? null, targetId: candidate.targetId, outcome: s?.outcome ?? null }));
  }
  if ((candidate.type === "npcMove" || candidate.type === "npcStrike") && Array.isArray(r?.strikeRecords)) {
    return r.strikeRecords;
  }
  if (candidate.type === "feat" && (r?.attacks ?? 0) > 0) {
    return Array.from({ length: r.attacks }, (_v, i) => ({
      slug: null,
      targetId: candidate.targetId ?? null,
      outcome: r.strikeOutcomes?.[i] ?? null,
    }));
  }
  return [];
}

/** #933: the ready Strike actions a shape may use: the named limb (a
 * melee or ranged Strike), or -- `limb` null, "makes a melee Strike" --
 * every ready melee Strike. `{ slug, label, reachSquares, action }`. */
function npcStrikeActions(actor, limb, gridDistanceFt) {
  const ready = (actor?.system?.actions ?? [])
    .filter((a) => a.type === "strike" && a.ready !== false)
    .map((a) => ({
      slug: a.item?.slug ?? a.slug ?? a.label,
      label: a.label,
      reachSquares: actionReachSquares(a, gridDistanceFt),
      action: a,
      melee: isMeleeStrikeAction(a),
    }));
  if (!limb) return ready.filter((a) => a.melee);
  const matched = matchMultiStrikeActionSlug(limb, ready);
  return matched ? [matched] : [];
}

/** Grab requirements may name the body part ("Grabbed with its talons",
 * "Grabbed by claws only"); the record keeps the Strike the grab rode on. */
function grabLimbMatches(required, recorded) {
  if (!required) return true;
  if (!recorded) return false;
  const norm = (s) => String(s).toLowerCase().replace(/s$/, "");
  return norm(recorded) === norm(required) || norm(recorded).includes(norm(required));
}

function inStrikeReach(combat, combatant, target, squares, gridSize) {
  if (!target?.token) return false;
  return (
    chebyshevSquares(combatant.token, target.token, gridSize) <= squares + REACH_EPSILON &&
    hasLineOfSight(combat, combatant.token, target.token)
  );
}

function tokensAdjacent(a, b, gridSize) {
  return chebyshevSquares(a.token, b.token, gridSize) <= MELEE_REACH_SQUARES;
}

/** Lowest current HP first, then id -- the order secondary targets of a
 * multi-target ability are chosen in (focus the most hurt). */
function byHpThenId(a, b) {
  const hp = (c) => c.actor?.system?.attributes?.hp?.value ?? Infinity;
  return hp(a) - hp(b) || String(a.id).localeCompare(String(b.id));
}

/** Hurl Net's "wielding a net": a physical Net item; each one can be hurled
 * once (it leaves the creature's hands with the throw). */
function npcNetItem(actor) {
  return (
    Array.from(actor?.items ?? []).find(
      (i) => ["equipment", "weapon"].includes(i?.type) && /^net$/i.test(String(i?.name ?? "").trim()),
    ) ?? null
  );
}

function netsHurled(combat, combatantId) {
  return combat.getFlag?.(MODULE_ID, "npcNetsHurled")?.[combatantId] ?? 0;
}

async function recordNetHurled(combat, combatantId) {
  const current = combat.getFlag?.(MODULE_ID, "npcNetsHurled") ?? {};
  await combat.setFlag(MODULE_ID, "npcNetsHurled", { ...current, [combatantId]: (current[combatantId] ?? 0) + 1 });
}

function actorSizeOf(actor) {
  return actor?.size ?? actor?.system?.traits?.size?.value ?? "med";
}

/**
 * #933: the target groups a parsed Strike-plus ability (`descriptor`) can be
 * used against right now, as `[{ targetIds }]` (first id = primary target),
 * checked against the live board: the named Strike is ready, targets are in
 * its reach (or the ability's stated reach/range) with a clear line, the
 * grab record is live (and made with the required body part), Hurl Net's
 * size cap and net, Rend's two consecutive hits. `targets` are the
 * combatants the creature may target (detection-filtered).
 */
function npcStrikeOptions(combat, combatant, item, descriptor, targets) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const actor = combatant.actor;
  const { shape, params, requirement } = descriptor;
  const live = targets.filter((t) => t?.token && !t.isDefeated);

  if (requirement?.grabbed) {
    const grab = currentGrabTarget(combat, combatant);
    if (!grab || !grabLimbMatches(requirement.grabLimb, grab.record.limb)) return [];
    const target = live.find((t) => t.id === grab.target.id);
    if (!target) return [];
    if (shape === "constrictLike") return [{ targetIds: [target.id] }];
    if (shape !== "strikeAgainstGrabbed") return [];
    const [action] = npcStrikeActions(actor, params.limb, gridDistanceFt);
    if (!action || !inStrikeReach(combat, combatant, target, action.reachSquares, gridSize)) return [];
    return [{ targetIds: [target.id] }];
  }

  if (shape === "extendedReachStrike") {
    const [action] = npcStrikeActions(actor, params.limb, gridDistanceFt);
    if (!action) return [];
    const reach = Math.floor(params.reachFeet / gridDistanceFt);
    // Only worth its extra action beyond the Strike's normal reach.
    return live
      .filter((t) => inStrikeReach(combat, combatant, t, reach, gridSize))
      .filter((t) => !inStrikeReach(combat, combatant, t, action.reachSquares, gridSize))
      .map((t) => ({ targetIds: [t.id] }));
  }

  if (shape === "twoTargetStrikes" || shape === "singleRollMultiAC" || shape === "bundleWithBothHitRider") {
    const actions = npcStrikeActions(actor, params.limb, gridDistanceFt);
    const action = actions[0];
    if (!action) return [];
    const inReach = live.filter((t) => inStrikeReach(combat, combatant, t, action.reachSquares, gridSize));
    if (shape === "bundleWithBothHitRider") return inReach.map((t) => ({ targetIds: [t.id] }));
    const options = [];
    for (const primary of inReach) {
      const others = inReach.filter((t) => t.id !== primary.id).sort(byHpThenId);
      if (shape === "twoTargetStrikes") {
        const partner = others.find((t) => !params.adjacentTargets || tokensAdjacent(primary, t, gridSize));
        if (partner) options.push({ targetIds: [primary.id, partner.id] });
        continue;
      }
      const group = [primary];
      for (const t of others) {
        if (group.length >= params.maxTargets) break;
        const fits =
          params.adjacency === "eachOther"
            ? group.every((g) => tokensAdjacent(g, t, gridSize))
            : params.adjacency === "atLeastOne"
              ? group.some((g) => tokensAdjacent(g, t, gridSize))
              : true;
        if (fits) group.push(t);
      }
      // One foe only would just be a Strike that costs two attacks of MAP.
      if (group.length >= 2) options.push({ targetIds: group.map((g) => g.id) });
    }
    return options;
  }

  if (shape === "strikeWithOnHit") {
    if (requirement?.item !== "net") return [];
    const net = npcNetItem(actor);
    const quantity = Number(net?.system?.quantity ?? 1) || 1;
    if (!net || netsHurled(combat, combatant.id) >= quantity) return [];
    const range = Math.floor(params.rangeFeet / gridDistanceFt);
    const cap = SIZE_ORDER.indexOf(params.sizeCap);
    return live
      .filter((t) => inStrikeReach(combat, combatant, t, range, gridSize))
      .filter((t) => {
        const size = SIZE_ORDER.indexOf(actorSizeOf(t.actor));
        return cap >= 0 && size >= 0 && size <= cap;
      })
      .map((t) => ({ targetIds: [t.id] }));
  }

  if (shape === "rend") {
    const [action] = npcStrikeActions(actor, params.limb, gridDistanceFt);
    if (!action) return [];
    const log = getTurnStrikeLog(combat, combatant.id);
    const [a, b] = log.slice(-2);
    if (!a || !b) return [];
    if (a.slug !== action.slug || b.slug !== action.slug || a.targetId !== b.targetId) return [];
    if (!isHitOutcome(a.outcome) || !isHitOutcome(b.outcome)) return [];
    const target = live.find((t) => t.id === a.targetId);
    return target ? [{ targetIds: [target.id] }] : [];
  }
  return [];
}

/**
 * #933: the Strike-plus abilities `combatant` (an NPC) can use right now, as
 * buildNpcStrikeVocabulary's entries: parsed (npc-strike-shapes.mjs),
 * affordable this turn, with frequency uses left and off recharge, and with
 * at least one legal target group (npcStrikeOptions).
 */
export function computeNpcStrikeEntries(combat, combatant, targets, actionsRemaining) {
  const actor = combatant?.actor;
  if (actor?.type !== "npc") return [];
  const entries = [];
  for (const item of actorActionItems(actor)) {
    const descriptor = parseStrikePlusAbility(item);
    if (!descriptor) continue;
    if (descriptor.cost > actionsRemaining) continue;
    const uses = descriptor.frequency?.value;
    if (descriptor.frequency && !(typeof uses === "number" && uses > 0)) continue;
    const slug = actionItemSlug(item);
    if (!isAbilityRecharged(combat, combatant.id, slug)) continue;
    const options = npcStrikeOptions(combat, combatant, item, descriptor, targets);
    if (!options.length) continue;
    entries.push({
      itemId: item.id,
      slug,
      name: item.name,
      cost: descriptor.cost,
      shape: descriptor.shape,
      traits: featGatingTraits(item),
      descriptor,
      options,
    });
  }
  return entries;
}

/** #933: a pf2e circumstance Modifier for an ability's attack bonus (Death
 * Roll's +2), or null when the system class is unavailable. */
function circumstanceModifier(slug, label, value) {
  const Modifier = game.pf2e?.Modifier;
  if (typeof Modifier !== "function" || !value) return null;
  return new Modifier({ slug, label, modifier: value, type: "circumstance" });
}

/** #933: creates a linked bestiary effect ("Effect: Mangling Rend", "Effect:
 * Hurl Net") on `target`, the way the system's own chat-card button does:
 * the compendium source, an origin context (the NPC, its token and the
 * ability), the target, and -- for an effect with a degree-of-success
 * ChoiceSet (Hurl Net) -- that choice pre-selected so no prompt opens. The
 * link is name-based, which `fromUuid` doesn't resolve, so the pack index
 * is searched by name. Returns true when the effect was created. */
async function applyBestiaryEffect(combatant, item, target, effectName, { selection = null } = {}) {
  try {
    const pack = game.packs?.get?.("pf2e.bestiary-effects");
    const index = await pack?.getIndex?.();
    const entry = Array.from(index ?? []).find((e) => e.name === effectName);
    const doc = entry ? await pack.getDocument(entry._id) : null;
    if (typeof doc?.toObject !== "function") return false;
    const source = doc.toObject();
    delete source._id;
    if (selection) {
      for (const rule of source.system?.rules ?? []) {
        if (rule?.key === "ChoiceSet") rule.selection = selection;
      }
    }
    source.system = {
      ...source.system,
      context: {
        origin: {
          actor: combatant.actor?.uuid ?? null,
          token: combatant.token?.uuid ?? null,
          item: item?.uuid ?? null,
          spellcasting: null,
          rollOptions: [],
        },
        target: { actor: target.actor?.uuid ?? null, token: target.token?.uuid ?? null },
        roll: null,
      },
    };
    await target.actor.createEmbeddedDocuments("Item", [source]);
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | #933: applying ${effectName} failed:`, err?.message);
    return false;
  }
}

/** Rolls the given Strikes against `target` one after another (each at its
 * own MAP variant), stopping once the target is defeated. Returns the
 * outcomes of the Strikes really made. */
async function npcStrikeSeries(combat, combatant, target, actionSlug, variants, extras = null) {
  const outcomes = [];
  for (const variant of variants) {
    if (target.isDefeated || combatant.isDefeated) break;
    outcomes.push((await rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, variant, extras)) ?? null);
  }
  return outcomes;
}

function strikeResultText(outcomes) {
  return outcomes.map((o) => NPC_STRIKE_HIT_TEXT[o] ?? "no result").join(", ") || "no Strike made";
}

function strikeTone(outcomes) {
  if (!outcomes.length) return "neutral";
  if (outcomes.every(isHitOutcome)) return "success";
  if (!outcomes.some(isHitOutcome)) return "failure";
  return "neutral";
}

/** #933: Wrestle, Death Roll, Twisting Thrash, Gnaw, Maul, Rapid Rake. */
async function executeStrikeAgainstGrabbed(combat, combatant, item, descriptor, target) {
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const { params } = descriptor;
  const [action] = npcStrikeActions(combatant.actor, params.limb, gridDistanceFt);
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const variants = Array.from({ length: params.count }, (_v, i) => (params.mapRule === "same" ? mapIncrement : mapIncrement + i));
  const bonus = circumstanceModifier(actionItemSlug(item), item.name, params.attackBonus);
  const outcomes = await npcStrikeSeries(combat, combatant, target, action.slug, variants, bonus ? { modifiers: [bonus] } : null);
  const applied = [];
  const gmLines = [];
  const hit = outcomes.length === 1 && isHitOutcome(outcomes[0]);
  if (hit && !target.isDefeated) {
    for (const effect of params.onHit) {
      try {
        if (effect.kind === "condition") {
          if (await applyNpcAbilityCondition(target.actor, { slug: effect.slug, value: null })) applied.push(effect.slug);
        } else if (effect.kind === "save") {
          const outcome = await rollNpcAbilitySave(combatant, target, item, {
            save: effect.save,
            dc: effect.dc,
            traits: [...(effect.traits ?? []), ...(item.system?.traits?.value ?? [])],
            rollOptions: effect.rollOptions ?? [],
          });
          if (!outcome) {
            gmLines.push(`${effect.save} DC ${effect.dc}: no save result -- resolve by hand`);
            continue;
          }
          applied.push(`${SAVE_OUTCOME_TEXT[outcome] ?? outcome}: ${await applyNpcAbilityDegree(combat, combatant, item, target, effect.degrees[outcome])}`);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | #933: ${item.name}'s rider failed:`, err?.message);
        gmLines.push(`${item.name}: rider failed (${err?.message}) -- apply by hand`);
      }
    }
  }
  if (params.onMissRelease && outcomes.length === 1 && !isHitOutcome(outcomes[0])) {
    if (await releaseGrab(combat, combatant)) applied.push("grab released");
  }
  const text = [strikeResultText(outcomes), ...applied].join("; ");
  return {
    attacks: outcomes.length,
    strikeRecords: outcomes.map((outcome) => ({ slug: action.slug, targetId: target.id, outcome })),
    results: [{ targetId: target.id, text, tone: strikeTone(outcomes) }],
    gmLines,
  };
}

const SAVE_OUTCOME_TEXT = Object.freeze({
  criticalSuccess: "critical success",
  success: "success",
  failure: "failure",
  criticalFailure: "critical failure",
});

/** #933: Constrict / Greater Constrict -- the listed damage to the grabbed
 * creature, which attempts a basic Fortitude save (rolled the way the
 * system's inline @Check does); Greater Constrict's Unconscious on a failed
 * save unless the creature is temporarily immune from an earlier success. */
async function executeConstrictLike(combat, combatant, item, descriptor, target) {
  const { params } = descriptor;
  const outcome = await rollNpcAbilitySave(combatant, target, item, {
    save: params.save,
    dc: params.dc,
    traits: [...(params.traits ?? []), ...(item.system?.traits?.value ?? [])],
    rollOptions: params.rollOptions ?? [],
  });
  if (!outcome) {
    return { attacks: 0, strikeRecords: [], results: [{ targetId: target.id, text: "no save result", tone: "neutral" }], gmLines: [`Fortitude DC ${params.dc}: no save result -- resolve ${params.damage} by hand`] };
  }
  const DamageRollClass = CONFIG.Dice.rolls.find((c) => c.name === "DamageRoll");
  if (outcome !== "criticalSuccess" && DamageRollClass) {
    const roll = new DamageRollClass(params.damage);
    await roll.evaluate();
    await applyBasicSaveDamage(roll, outcome, target);
  }
  const parts = [SAVE_OUTCOME_TEXT[outcome]];
  if (params.degrees && !target.isDefeated) {
    const worldTime = globalThis.game?.time?.worldTime ?? 0;
    if (worldTime < getNpcAbilityImmunityUntil(combat, item.id, target.id)) {
      parts.push("immune to falling unconscious");
    } else {
      const applied = await applyNpcAbilityDegree(combat, combatant, item, target, params.degrees[outcome]);
      if (applied && applied !== "no effect") parts.push(applied);
    }
  }
  const tone = outcome === "failure" || outcome === "criticalFailure" ? "success" : "failure";
  return { attacks: 0, strikeRecords: [], results: [{ targetId: target.id, text: parts.join(": "), tone }], gmLines: [] };
}

/** #933: Lunging Bite -- a plain Strike; the extended reach was checked
 * when the options were built (and again just before this runs). */
async function executeExtendedReachStrike(combat, combatant, item, descriptor, target) {
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const [action] = npcStrikeActions(combatant.actor, descriptor.params.limb, gridDistanceFt);
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const outcomes = await npcStrikeSeries(combat, combatant, target, action.slug, [mapIncrement]);
  return {
    attacks: outcomes.length,
    strikeRecords: outcomes.map((outcome) => ({ slug: action.slug, targetId: target.id, outcome })),
    results: [{ targetId: target.id, text: strikeResultText(outcomes), tone: strikeTone(outcomes) }],
    gmLines: [],
  };
}

/** #933: Broad Swipe (both Strikes at the current MAP, which then rises by
 * both: "Both attacks count toward the multiple attack penalty, but the
 * penalty doesn't increase until after both attacks") and the zombie
 * hulk's Wide Swing (two Strikes, normal MAP). */
async function executeTwoTargetStrikes(combat, combatant, item, descriptor, targets) {
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const { params } = descriptor;
  const [action] = npcStrikeActions(combatant.actor, params.limb, gridDistanceFt);
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const results = [];
  const strikeRecords = [];
  let made = 0;
  for (const target of targets) {
    const variant = params.mapRule === "same" ? mapIncrement : mapIncrement + made;
    const outcomes = await npcStrikeSeries(combat, combatant, target, action.slug, [variant]);
    made += outcomes.length;
    for (const outcome of outcomes) strikeRecords.push({ slug: action.slug, targetId: target.id, outcome });
    results.push({ targetId: target.id, text: strikeResultText(outcomes), tone: strikeTone(outcomes) });
  }
  return { attacks: made, strikeRecords, results, gmLines: [] };
}

/** #933: Wide Swing / Swipe / Tail Sweep -- ONE attack roll (made against
 * the primary target through the ordinary Strike path, riders and critical
 * deck included), compared independently against each other target's AC
 * with PF2e's degree-of-success rules (natural 20/1 included); each target
 * hit takes the Strike's damage at its own degree. Counts as `mapCount`
 * attacks. */
async function executeSingleRollMultiAC(combat, combatant, item, descriptor, targets) {
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const { params } = descriptor;
  const actions = npcStrikeActions(combatant.actor, params.limb, gridDistanceFt);
  const gridSize = combat.scene?.grid?.size ?? 100;
  const [primary, ...others] = targets;
  const action = actions.find((a) => targets.every((t) => inStrikeReach(combat, combatant, t, a.reachSquares, gridSize))) ?? actions[0];
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const report = {};
  const outcome = await rollAndApplyStrikeAtVariant(combat, combatant, primary, action.slug, mapIncrement, { report });
  const results = [{ targetId: primary.id, text: NPC_STRIKE_HIT_TEXT[outcome] ?? "no result", tone: strikeTone(outcome ? [outcome] : []) }];
  const strikeRecords = [{ slug: action.slug, targetId: primary.id, outcome: outcome ?? null }];
  const total = Number(report.attackRoll?.total);
  const natural = naturalD20(report.attackRoll);
  for (const target of others) {
    if (!Number.isFinite(total) || target.isDefeated) {
      results.push({ targetId: target.id, text: "no result", tone: "neutral" });
      continue;
    }
    const ac = target.actor?.armorClass?.value ?? target.actor?.system?.attributes?.ac?.value;
    if (typeof ac !== "number") {
      results.push({ targetId: target.id, text: "no AC -- resolve by hand", tone: "neutral" });
      continue;
    }
    const degree = degreeOfSuccess(total, ac, natural);
    if (isHitOutcome(degree)) {
      try {
        const damageRoll = await withDialogsSuppressed(() =>
          action.action.damage({ target: { document: target.token }, outcome: degree, createMessage: true }),
        );
        if (damageRoll) {
          await target.actor.applyDamage({ damage: damageRoll, token: target.token, outcome: degree });
          await applyDefeatIfReducedToZero(target);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | #933: ${item.name} damage against ${target.name} failed:`, err?.message);
      }
    }
    results.push({ targetId: target.id, text: NPC_STRIKE_HIT_TEXT[degree], tone: strikeTone([degree]) });
  }
  const gmLines = [`One attack roll (${Number.isFinite(total) ? total : "?"}) compared to each target's AC.`];
  if (params.damageOnce) gmLines.push("Damage is rolled per target hit (RAW: once for all).");
  return { attacks: params.mapCount, strikeRecords, results, gmLines };
}

/** #933: Mangling Rend -- the bundle's Strikes with the normal MAP
 * escalation; only when EVERY one of them hit does the rider land: the
 * extra damage, the conditions (Off-Guard until the end of the target's
 * next turn) and the linked effect (the Speed penalty). */
async function executeBundleWithBothHitRider(combat, combatant, item, descriptor, target) {
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const { params } = descriptor;
  const [action] = npcStrikeActions(combatant.actor, params.limb, gridDistanceFt);
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const variants = Array.from({ length: params.count }, (_v, i) => mapIncrement + i);
  const outcomes = await npcStrikeSeries(combat, combatant, target, action.slug, variants);
  const allHit = outcomes.length === params.count && outcomes.every(isHitOutcome);
  const applied = [];
  const gmLines = [];
  if (allHit && !target.isDefeated) {
    if (params.extraDamage) {
      try {
        const DamageRollClass = CONFIG.Dice.rolls.find((c) => c.name === "DamageRoll");
        const roll = new DamageRollClass(params.extraDamage);
        await roll.evaluate();
        await target.actor.applyDamage({ damage: roll, token: target.token, outcome: "success" });
        await applyDefeatIfReducedToZero(target);
        applied.push(`+${roll.total ?? params.extraDamage} damage`);
      } catch (err) {
        console.error(`${MODULE_ID} | #933: ${item.name}'s extra damage failed:`, err?.message);
        gmLines.push(`Extra ${params.extraDamage} damage failed -- apply by hand`);
      }
    }
    if (!target.isDefeated) {
      const conditionText = await applyNpcAbilityDegree(combat, combatant, item, target, {
        none: false,
        conditions: params.conditions,
        immuneSeconds: null,
      });
      if (conditionText && conditionText !== "no effect") applied.push(conditionText);
      if (params.effectName) {
        if (await applyBestiaryEffect(combatant, item, target, params.effectName)) applied.push(params.effectName.replace(/^Effect:\s*/, ""));
        else gmLines.push(`${params.effectName} could not be applied -- apply by hand`);
      }
    }
  }
  const text = [strikeResultText(outcomes), ...applied].join("; ");
  return {
    attacks: outcomes.length,
    strikeRecords: outcomes.map((outcome) => ({ slug: action.slug, targetId: target.id, outcome })),
    results: [{ targetId: target.id, text, tone: strikeTone(outcomes) }],
    gmLines,
  };
}

/** #933: Hurl Net -- a ranged Strike with the ability's own fixed attack
 * modifier (plus this turn's multiple attack penalty, a net not being
 * agile) against the target's AC, cover included. A hit or critical hit
 * creates the Hurl Net effect with its degree pre-chosen (the effect itself
 * grants Off-Guard and the -10-foot Speed penalty, or Restrained); the net
 * is spent either way. */
async function executeStrikeWithOnHit(combat, combatant, item, descriptor, target) {
  const { params } = descriptor;
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const penalty = maneuverMapPenalty({ attackNumber: mapIncrement + 1, weaponIsAgile: false });
  await recordNetHurled(combat, combatant.id);
  const outcome = await withCoverBonus(combat, combatant, target, async () => {
    const ac = target.actor?.armorClass?.value ?? target.actor?.system?.attributes?.ac?.value;
    const formula = `1d20 + ${params.fixedModifier}${penalty ? ` - ${Math.abs(penalty)}` : ""}`;
    const roll = new Roll(formula);
    await roll.evaluate();
    try {
      await roll.toMessage?.({
        speaker: typeof ChatMessage.getSpeaker === "function" ? ChatMessage.getSpeaker({ actor: combatant.actor, token: combatant.token }) : undefined,
        flavor: `${item.name}: ranged Strike vs ${target.name}`,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | #933: posting ${item.name}'s roll failed:`, err?.message);
    }
    if (typeof ac !== "number") return null;
    return degreeOfSuccess(roll.total, ac, naturalD20(roll));
  });
  const gmLines = [];
  const applied = [];
  if (isHitOutcome(outcome)) {
    const selection = outcome === "criticalSuccess" ? "critical-success" : "success";
    if (await applyBestiaryEffect(combatant, item, target, params.effectName, { selection })) {
      applied.push(outcome === "criticalSuccess" ? "restrained" : "off-guard, -10 ft Speeds");
    } else {
      gmLines.push(`${params.effectName} could not be applied -- apply by hand`);
    }
    if (params.escapeDc) gmLines.push(`The net's Escape DC is ${params.escapeDc}; remove the effect when it is escaped or cut away.`);
  }
  if (outcome == null) gmLines.push("No AC to compare -- resolve by hand");
  const outcomes = outcome ? [outcome] : [];
  return {
    attacks: 1,
    strikeRecords: [{ slug: null, targetId: target.id, outcome: outcome ?? null }],
    results: [{ targetId: target.id, text: [strikeResultText(outcomes), ...applied].join("; "), tone: strikeTone(outcomes) }],
    gmLines,
  };
}

/** #933: Rend -- "the monster automatically deals that Strike's damage
 * again" (normal damage, no attack roll, not an attack). */
async function executeRend(combat, combatant, item, descriptor, target) {
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const [action] = npcStrikeActions(combatant.actor, descriptor.params.limb, gridDistanceFt);
  let text = "no damage";
  try {
    const damageRoll = await withDialogsSuppressed(() =>
      action.action.damage({ target: { document: target.token }, outcome: "success", createMessage: true }),
    );
    if (damageRoll) {
      await target.actor.applyDamage({ damage: damageRoll, token: target.token, outcome: "success" });
      await applyDefeatIfReducedToZero(target);
      text = `${damageRoll.total ?? "?"} damage`;
    }
  } catch (err) {
    console.error(`${MODULE_ID} | #933: Rend damage failed:`, err?.message);
    return { attacks: 0, strikeRecords: [], results: [{ targetId: target.id, text: "not resolved", tone: "neutral" }], gmLines: [`Rend failed (${err?.message}) -- apply ${action.label} damage by hand`] };
  }
  return { attacks: 0, strikeRecords: [], results: [{ targetId: target.id, text, tone: "success" }], gmLines: [] };
}

const NPC_STRIKE_EXECUTORS = Object.freeze({
  strikeAgainstGrabbed: executeStrikeAgainstGrabbed,
  constrictLike: executeConstrictLike,
  extendedReachStrike: executeExtendedReachStrike,
  twoTargetStrikes: executeTwoTargetStrikes,
  singleRollMultiAC: executeSingleRollMultiAC,
  bundleWithBothHitRider: executeBundleWithBothHitRider,
  strikeWithOnHit: executeStrikeWithOnHit,
  rend: executeRend,
});
const NPC_STRIKE_MULTI_TARGET = new Set(["twoTargetStrikes", "singleRollMultiAC"]);

/**
 * #933: executes a chosen Strike-plus ability. Re-resolves the item, its
 * parse and the exact target group against the current board
 * (npcStrikeOptions) -- a stale grab (Escaped, released, the target
 * defeated), a target out of reach, a spent net or a broken Rend chain
 * returns `{ performed: false }` BEFORE anything is spent. Otherwise it
 * spends a frequency use, posts the ability card and runs the shape's
 * executor, which reuses the ordinary Strike/damage/condition primitives.
 * Returns `{ performed, attacks, results, strikeRecords, gmNote }`.
 */
async function executeNpcStrikeCandidate(combat, combatant, candidate) {
  const item = actorActionItems(combatant.actor).find((i) => i.id === candidate.itemId);
  const descriptor = item ? parseStrikePlusAbility(item) : null;
  if (!descriptor || descriptor.shape !== candidate.shape) return { performed: false };
  const targets = (candidate.targetIds ?? []).map((id) => resolveOpponentForTurn(combat, combatant, id));
  if (!targets.length || targets.some((t) => !t)) return { performed: false };
  await snapTokenToGrid(combatant.token, combat.scene?.grid?.size ?? 100);
  const key = candidate.targetIds.join(",");
  const options = npcStrikeOptions(combat, combatant, item, descriptor, combatantTargets(combat, combatant));
  if (!options.some((o) => o.targetIds.join(",") === key)) return { performed: false, reason: "not legal now" };

  const uses = item.system?.frequency?.value;
  if (typeof uses === "number") {
    await item.update({ "system.frequency.value": Math.max(0, uses - 1) });
  }
  try {
    await item.toMessage?.();
  } catch (err) {
    console.error(`${MODULE_ID} | #933: posting ${item.name} failed:`, err?.message);
  }
  const execute = NPC_STRIKE_EXECUTORS[descriptor.shape];
  const run = NPC_STRIKE_MULTI_TARGET.has(descriptor.shape)
    ? () => execute(combat, combatant, item, descriptor, targets)
    : () => execute(combat, combatant, item, descriptor, targets[0]);
  let outcome;
  try {
    outcome = await run();
  } catch (err) {
    console.error(`${MODULE_ID} | #933: ${item.name} failed:`, err?.message);
    outcome = {
      attacks: 0,
      strikeRecords: [],
      results: targets.map((t) => ({ targetId: t.id, text: "not resolved", tone: "neutral" })),
      gmLines: [`${item.name} failed (${err?.message}) -- resolve by hand`],
    };
  }
  return {
    performed: true,
    attacks: outcome.attacks ?? 0,
    results: outcome.results ?? [],
    strikeRecords: outcome.strikeRecords ?? [],
    gmNote: outcome.gmLines?.length ? outcome.gmLines.join("\n") : null,
  };
}

/** Rolls one strike at a specific MAP `variantIndex` against `target` and
 * applies damage on a hit — the same dialog-suppression/roll/damage/
 * applyDamage sequence rollAndApplyStrike already uses, generalized to a
 * caller-chosen variant instead of always variants[0].
 * #931: `extras` (reaction Strikes only) adds roll options / modifiers to
 * the attack roll (Twisting Tail's -2) and `extras.report.pushed` reports a
 * successful push rider (Wing Rebuff's disruption). */
async function rollAndApplyStrikeAtVariant(
  combat,
  combatant,
  target,
  actionSlug,
  variantIndex,
  extras = null,
) {
  const strike = (combatant.actor?.system?.actions ?? []).find(
    (a) =>
      a.type === "strike" &&
      a.ready !== false &&
      (a.item?.slug ?? a.slug ?? a.label) === actionSlug,
  );
  if (!strike) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    return await withCoverBonus(combat, combatant, target, async () => {
      const targetRef = { document: target.token };
      const variant =
        strike.variants[Math.min(variantIndex, strike.variants.length - 1)];
      await variant.roll({
        target: targetRef,
        createMessage: true,
        ...(extras?.rollOptions?.length ? { options: [...extras.rollOptions] } : {}),
        ...(extras?.modifiers?.length ? { modifiers: [...extras.modifiers] } : {}),
      });
      // #976: see rollAndApplyStrike -- capture the attack message before
      // any rider can post a newer one.
      const attackMessage = game.messages.contents.at(-1);
      // #933: Wide Swing compares this one roll to other targets' ACs.
      if (extras?.report) extras.report.attackRoll = attackMessage?.rolls?.[0] ?? null;
      // #931: see rollAndApplyStrike -- an AC-bonus reaction may turn the hit
      // into a miss first.
      const outcome = await applyTargetedByAttackReactions(
        combat,
        combatant,
        target,
        attackMessage,
        attackMessage?.flags?.pf2e?.context?.outcome ?? null,
      );
      const natural = naturalD20(attackMessage?.rolls?.[0]);
      const soundContext = strikeSoundContext(strike, target);
      playStrikeSound(outcome, soundContext);
      await postStrikeRiderReminder(combatant, strike, outcome);
      await resolveGrabRider(combatant, target, strike, outcome, combat);
      await resolveKnockdownRider(combatant, target, strike, outcome);
      await resolveAthleticsRider(combatant, target, strike, outcome, {
        slugs: PUSH_RIDER_SLUGS,
        saveKey: "fortitude",
        label: "Push",
        onSuccess: async (rollOutcome) => {
          const distanceSquares = rollOutcome === "criticalSuccess" ? 2 : 1;
          await pushTokenAway(combat, combatant, target, distanceSquares);
          if (extras?.report) extras.report.pushed = true;
          return `target is pushed ${distanceSquares * 5} feet away`;
        },
      });
      const damageMultiplier = await drawCriticalCardForStrike(
        outcome,
        strike,
        soundContext,
        combatant,
        target,
        natural,
      );
      if (outcome === "success" || outcome === "criticalSuccess") {
        const damageRoll = await strike.damage({
          target: targetRef,
          outcome,
          createMessage: true,
        });
        if (damageRoll) {
          // #61: see rollAndApplyStrike's identical comment -- only
          // "triple damage" needs an extra 1.5x on top of the crit
          // doubling strike.damage() already applied; "double damage"
          // already matches that doubling exactly.
          if (damageMultiplier === 3) {
            await damageRoll.alter(1.5, 0);
          }
          // #931: Shield Block -- the system applies Hardness itself.
          const shieldBlock = await resolveShieldBlockForHit(combat, combatant, target, damageRoll);
          await target.actor.applyDamage({
            damage: damageRoll,
            token: target.token,
            outcome,
            ...(shieldBlock ? { shieldBlockRequest: true } : {}),
          });
          await applyDefeatIfReducedToZero(target);
          // See rollAndApplyStrike's identical comment -- the crit-spec
          // Note (#36) only ever lands on this damage message, not the
          // attack-roll one `outcome` came from.
          await postCriticalSpecializationReminder(combatant, outcome);
        }
      }
      return outcome;
    });
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Executes a multi-strike bundle (Draconic Frenzy-shaped) as a sequence of
 * individual Strikes against `target`, all reusing
 * `rollAndApplyStrikeAtVariant` — the same per-strike execution primitive a
 * plain strike candidate uses. `variantIndex` increments once per strike
 * ACROSS THE WHOLE BUNDLE (not reset between the bundle's own named
 * strikes), starting from `baseVariantIndex` (the turn's current
 * `mapIncrement`) — matching PF2E's own MAP rule that the penalty escalates
 * per attack this turn regardless of whether those attacks come from
 * separate actions or a single multi-strike ability. Returns the ordered
 * list of `{actionSlug, outcome}` results.
 */
async function castMultiStrikeBundleAndApply(
  combat,
  combatant,
  target,
  strikes,
  baseVariantIndex,
) {
  const results = [];
  let variantIndex = baseVariantIndex;
  for (const { actionSlug, count } of strikes) {
    for (let i = 0; i < count; i++) {
      const outcome = await rollAndApplyStrikeAtVariant(
        combat,
        combatant,
        target,
        actionSlug,
        variantIndex,
      );
      results.push({ actionSlug, outcome });
      variantIndex += 1;
    }
  }
  return results;
}

/**
 * Applies a basic-save spell's damage roll, scaled by the target's own
 * save outcome -- #81/#83: `spell.rollDamage()` never scales by outcome
 * internally (confirmed against the real PF2e system source), so every
 * basic-save call site needs to do this explicitly. Originally inlined
 * separately in `castSpellAndApplySave`/`castAreaSpellAndApplySaves`
 * (#81/#82) and then duplicated -- buggily, without the scaling -- into
 * three more call sites; #83 centralizes the correct version here so
 * there's exactly one place this branching lives. Zero damage on a
 * criticalSuccess (skipped entirely, no `applyDamage` call at all); half
 * (`.alter(0.5, 0)`) on success; unscaled on failure; double
 * (`.alter(2, 0)`) on criticalFailure.
 */
export async function applyBasicSaveDamage(damageRoll, outcome, target) {
  if (!damageRoll || outcome === "criticalSuccess") return;
  const scaled =
    outcome === "success"
      ? await damageRoll.alter(0.5, 0)
      : outcome === "criticalFailure"
        ? await damageRoll.alter(2, 0)
        : damageRoll; // failure: full damage, unscaled
  await target.actor.applyDamage({
    damage: scaled,
    token: target.token,
    outcome,
  });
  await applyDefeatIfReducedToZero(target);
}

/**
 * Casts `spellId` (from spellcasting entry `entryId`) at `target`, rolls the
 * target's own save against the spell's DC, then rolls and applies damage —
 * confirmed live this is a 4-step chain, not the single `cast()` call a
 * strike's `.roll()` might suggest by analogy: `entryDoc.cast()` alone
 * announces the spell (posts its chat card) but rolls no save and applies no
 * damage. The target's own `actor.saves[save].roll({dc})` produces the real
 * outcome. #81/#83: `spell.rollDamage({target, outcome})` does NOT scale by
 * outcome internally despite this function's own prior docblock claiming
 * otherwise — confirmed against the real PF2e system source it always
 * returns a flat, un-scaled roll, the same way #75/#79 already found for
 * `castAttackSpellAndApplyRoll`. So a basic save's own scaling rule
 * (half on `success`, double on `criticalFailure`, unscaled on `failure`,
 * and — the worst of the un-fixed behavior — zero damage on
 * `criticalSuccess`, the apply-damage step skipped entirely rather than
 * calling `applyDamage` with a zeroed roll) is applied via the shared
 * `applyBasicSaveDamage` helper above, the same one every other basic-save
 * call site in this file now uses. Same dialog-suppression convention as
 * rollAndApplyStrikeAtVariant, since neither the save roll nor the damage
 * roll forwards a skipDialog option of its own.
 */
export async function castSpellAndApplySave(
  combatant,
  target,
  spellId,
  entryId,
  save,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const saveStat = target.actor?.saves?.[save];
  if (!saveStat) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    const targetRef = { document: target.token };
    await entry.cast(spell, { target: targetRef, createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    await saveStat.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    playSpellSaveSound(outcome);
    const damageRoll = await spell.rollDamage?.({
      target: targetRef,
      outcome,
      createMessage: true,
    });
    await applyBasicSaveDamage(damageRoll, outcome, target);
    return outcome;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Casts `spellId` (from spellcasting entry `entryId`) once, then rolls each
 * of `targets`' own saves against the spell's DC and applies damage to each
 * independently — confirmed live this is the correct way to resolve a
 * burst/emanation against the affected set `getPendingAgentTurn` already
 * precomputed: PF2e's own area-spell chat card offers an interactive
 * `placeTemplate()` flow for the GM to draw the AoE on the canvas and
 * target tokens by hand, but since this module always knows in advance
 * which opponents a candidate's placement catches (that's how the
 * candidate was built), it bypasses that UI entirely and drives the same
 * per-target save/damage/apply sequence #118's castSpellAndApplySave uses
 * for a single target, just once per affected creature — including #81's
 * fix for that sequence's own outcome-scaling: `spell.rollDamage()` returns
 * a flat, un-scaled roll regardless of outcome, so each target's own
 * `.alter(mult, 0)` scaling (half on `success`, double on
 * `criticalFailure`, unscaled on `failure`, skipped entirely — zero damage —
 * on `criticalSuccess`) is applied per-target inside this loop, independent
 * of every other target's own outcome.
 */
export async function castAreaSpellAndApplySaves(
  combatant,
  targets,
  spellId,
  entryId,
  save,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    await entry.cast(spell, { createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    const outcomes = [];
    for (const target of targets) {
      const saveStat = target.actor?.saves?.[save];
      if (!saveStat) continue;
      const targetRef = { document: target.token };
      await saveStat.roll({ dc: { value: dc }, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      playSpellSaveSound(outcome);
      const damageRoll = await spell.rollDamage?.({
        target: targetRef,
        outcome,
        createMessage: true,
      });
      await applyBasicSaveDamage(damageRoll, outcome, target);
      outcomes.push({ targetId: target.id, outcome });
    }
    return outcomes;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Casts a #140-scoped tier-scaling area spell at the cost tier matching
 * `cost`, then rolls each target's own save and applies outcome-scaled
 * damage from *that tier's* formula — never `spell.rollDamage()`, since
 * confirmed live it has no notion of action-count tiers at all (it only
 * ever reads spell rank/heightening, always producing the spell's base/
 * minimum-tier damage regardless of how many actions were spent). Instead
 * constructs a real `DamageRoll` directly from the tier's own damage
 * instances, joined with commas (`"(NdM)[type1],(PdQ)[type2]"`) — confirmed
 * live this is the correct multi-instance syntax: a `+`-joined formula
 * silently collapses every instance into one combined "untyped" total,
 * losing per-type resistance/weakness handling entirely, while comma-
 * joining keeps each instance independently typed and IWR-correct. Scaled
 * with the roll's own `.alter(mult, 0)` for basic-save halving/doubling,
 * the same technique #123/#127 already use.
 */
async function castTierScalingAreaSpellAndApplySaves(
  combatant,
  targets,
  spellId,
  entryId,
  save,
  cost,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;
  const tier = resolveAreaSpellTiers(spell)[cost];
  if (!tier) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    await entry.cast(spell, { createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    const DamageRollClass = CONFIG.Dice.rolls.find(
      (c) => c.name === "DamageRoll",
    );
    const formula = tier.damage
      .map((d) => `(${d.formula})[${d.type}]`)
      .join(",");
    const outcomes = [];
    for (const target of targets) {
      const saveStat = target.actor?.saves?.[save];
      if (!saveStat) continue;
      await saveStat.roll({ dc: { value: dc }, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      playSpellSaveSound(outcome);
      if (outcome !== "criticalSuccess") {
        const roll = new DamageRollClass(formula);
        await roll.evaluate();
        const scaled =
          outcome === "success"
            ? await roll.alter(0.5, 0)
            : outcome === "criticalFailure"
              ? await roll.alter(2, 0)
              : roll;
        await target.actor.applyDamage({
          damage: scaled,
          token: target.token,
          outcome,
        });
        await applyDefeatIfReducedToZero(target);
      }
      outcomes.push({ targetId: target.id, outcome });
    }
    return outcomes;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Casts `spellId` (from spellcasting entry `entryId`) at `target` and rolls
 * a spell attack against its AC, applying damage only on a hit — confirmed
 * live this mirrors rollAndApplyStrike's own success/criticalSuccess gate,
 * not #118/#119's always-roll-damage save pattern (a miss on an attack roll
 * deals no damage at all, unlike a passed save which still takes half).
 * `spell.rollAttack(event, attackNumber, options)` takes its options as the
 * *third* argument (confirmed live — passing them first silently no-ops),
 * and needs `options.target` to be the bare target Actor rather than
 * `{document: token}`: it resolves the target internally via
 * `actor.getActiveTokens()`, which only finds tokens on the currently
 * *viewed* canvas scene — a real dependency, unlike every other roll in
 * this file, that holds naturally during actual play (the GM has the
 * combat's own scene open) but is worth calling out since it's easy to
 * miss. `attackNumber` is always 1 — no spell-attack MAP tracking in v1,
 * matching #118/#119's spells (only a Strike bumps `mapIncrement`).
 */
export async function castAttackSpellAndApplyRoll(
  combatant,
  target,
  spellId,
  entryId,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    const targetRef = { document: target.token };
    await entry.cast(spell, { target: targetRef, createMessage: true });
    await spell.rollAttack(null, 1, {
      target: target.actor,
      createMessage: true,
    });
    const attackMessage = game.messages.contents.at(-1);
    const outcome = attackMessage?.flags?.pf2e?.context?.outcome ?? null;
    playAttackSpellSound(outcome);
    // #976: a card only draws on a natural 20 crit / natural 1 fumble
    // (criticalCardKindFor). A 10+-margin crit still gets PF2e's own
    // baseline doubling below via `damageMultiplier = 1` (the #79
    // Math.max floor), just no card.
    const cardKind = criticalCardKindFor(
      outcome,
      naturalD20(attackMessage?.rolls?.[0]),
    );
    let damageMultiplier = outcome === "criticalSuccess" ? 1 : null;
    if (cardKind === "hit") {
      // Takes the first system.damage entry's own type as "the" spell's
      // damage type for a conditional card's (Corrosive/Combustion) own
      // acid/fire check -- correct for the common single-damage-instance
      // attack spell this module casts. A spell with multiple differently
      // -typed damage instances would have this pick by object key order
      // rather than by whichever instance the card actually means; no
      // spell this module casts does that today, so not worth a real
      // "which instance is primary" resolution rule until one does (#75
      // review).
      const damageType = Object.values(spell.system.damage ?? {})[0]?.type;
      damageMultiplier = await drawHitCardMultiplier("Bomb or Spell", {
        combatant,
        target,
        damageType,
      });
    } else if (cardKind === "fumble") {
      await drawAndApplyCriticalCard("fumble", "Spell", { combatant, target });
    }
    if (outcome === "success" || outcome === "criticalSuccess") {
      const damageRoll = await spell.rollDamage?.({
        target: targetRef,
        outcome,
        createMessage: true,
      });
      if (damageRoll) {
        // #75/#79: unlike strike.damage() (#61), spell.rollDamage() does NOT
        // pre-double on a crit -- confirmed against the real PF2e system
        // source -- so this resolves an *effective* multiplier before
        // altering the roll rather than trusting rollDamage() to have
        // scaled anything itself. `damageMultiplier` stays `null` unless a
        // crit occurred (1 for any crit, or the drawn card's own value),
        // so this check alone proves a plain "success" is never altered --
        // no need to re-check `outcome` here too. A drawn card's own
        // multiplier (2 or 3) already represents the FULL intended scaling
        // for that crit (per #75) and is used as-is; `Math.max(..., 2)`
        // applies PF2e's own baseline automatic crit-doubling (2x) as a
        // floor for a crit with no card, or a card with no multiplier text
        // -- this floor is the #79 fix.
        if (damageMultiplier != null) {
          await damageRoll.alter(Math.max(damageMultiplier, 2), 0);
        }
        await target.actor.applyDamage({
          damage: damageRoll,
          token: target.token,
          outcome,
        });
        await applyDefeatIfReducedToZero(target);
      }
    }
    return outcome;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Casts `spellId` (from spellcasting entry `entryId`) at `target`, rolls its
 * own save, and applies whichever conditions `conditionsByOutcome` maps to
 * the outcome that actually occurred — `getPendingAgentTurn` already parsed
 * this once per spell via `parseConditionsByOutcome`, so this never touches
 * the spell's description text itself. An outcome absent from the map
 * (parsed with nothing tagged for that tier) applies nothing — a safe
 * no-op, not a missed error. No damage-dialog suppression needed: #121's
 * spells carry no damage component by definition.
 */
async function castDebuffSpellAndApplyCondition(
  combatant,
  target,
  spellId,
  entryId,
  save,
  conditionsByOutcome,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const saveStat = target.actor?.saves?.[save];
  if (!saveStat) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
  });
  try {
    const targetRef = { document: target.token };
    await entry.cast(spell, { target: targetRef, createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    await saveStat.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    const conditions = conditionsByOutcome?.[outcome] ?? [];
    for (const { slug, value } of conditions) {
      await target.actor.increaseCondition(
        slug,
        value != null ? { value } : undefined,
      );
    }
    return outcome;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
    });
  }
}

/**
 * Casts a chain spell at `orderedTargets[0]` (the primary target), then
 * rolls each target's own save and applies outcome-scaled damage in chain
 * order, stopping early the moment a target critically succeeds — matching
 * Chain Lightning's own rule ("the chain ends if any one of the targets
 * critically succeeds"). Deliberately does *not* implement "roll the
 * damage only once, and apply it to each target" from the spell's rules
 * text: confirmed live that reconstructing a shared already-rolled total as
 * a fresh per-target `DamageRoll` for independent outcome scaling silently
 * drops IWR handling (a resistant target took full, un-reduced damage) —
 * so each target's damage is rolled independently via `spell.rollDamage()`,
 * the same already-proven per-target mechanism #119's
 * `castAreaSpellAndApplySaves` uses. A small, disclosed deviation from
 * strict rules text in favor of correctness.
 */
export async function castChainSpellAndApplySaves(
  combatant,
  orderedTargets,
  spellId,
  entryId,
  save,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell || !orderedTargets.length) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    const primaryRef = { document: orderedTargets[0].token };
    await entry.cast(spell, { target: primaryRef, createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    const outcomes = [];
    for (const target of orderedTargets) {
      const saveStat = target.actor?.saves?.[save];
      if (!saveStat) continue;
      const targetRef = { document: target.token };
      await saveStat.roll({ dc: { value: dc }, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      const damageRoll = await spell.rollDamage?.({
        target: targetRef,
        outcome,
        createMessage: true,
      });
      await applyBasicSaveDamage(damageRoll, outcome, target);
      outcomes.push({ targetId: target.id, outcome });
      if (outcome === "criticalSuccess") break;
    }
    return outcomes;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Casts a #132-scoped heal spell at `target` and restores HP — no save
 * roll at all (confirmed live the living/healing branch of a dual-nature
 * spell like Heal doesn't call for one, only its undead/damage branch
 * does) and no outcome-based scaling (the full rolled amount always
 * applies). Confirmed live that `spell.rollDamage()`'s result for a
 * healing-trait spell carries ambiguous `kinds: ["damage", "healing"]` that
 * `applyDamage` doesn't resolve into an actual HP change on its own — but
 * passing the *negated* rolled total as a plain number does: `applyDamage`
 * routes any negative `finalDamage` through its own `"healing-received"`
 * path, confirmed live this restores HP correctly (clamped at the actor's
 * own max, matching how any other HP update works) without needing to
 * disambiguate the roll's kind at all.
 */
async function castHealSpellAndApply(combatant, target, spellId, entryId) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    const targetRef = { document: target.token };
    await entry.cast(spell, { target: targetRef, createMessage: true });
    const healRoll = await spell.rollDamage?.({
      target: targetRef,
      createMessage: true,
    });
    if (healRoll?.total != null) {
      await target.actor.applyDamage({
        damage: -healRoll.total,
        token: target.token,
      });
    }
    return healRoll?.total ?? null;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Casts a #170-scoped buff spell at `target` and applies its linked Spell
 * Effect item — confirmed live `entry.cast()` alone creates no item on the
 * target at all (same "cast() only announces" pattern #132's own healRoll
 * and #121's condition application already need a separate step for);
 * `fromUuid(effectUuid)` fetches the real compendium effect
 * (`parseSpellEffectUuid`'s own result) and
 * `target.actor.createEmbeddedDocuments` is what actually grants it —
 * confirmed live directly against Mountain Resilience that this correctly
 * derives the effect's own rule elements (its resistance showed up in the
 * target's `system.attributes.resistances` immediately, no extra step
 * needed). Returns the applied effect's name, or `null` if the spell has
 * no ready action, no parseable effect UUID, or the UUID doesn't resolve.
 */
async function castBuffSpellAndApply(combatant, target, spellId, entryId) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const effectUuid = parseSpellEffectUuid(
    spell.system.description?.value ?? "",
  );
  if (!effectUuid) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
  });
  try {
    const targetRef = { document: target.token };
    await entry.cast(spell, { target: targetRef, createMessage: true });
    const effectDoc = await fromUuid(effectUuid);
    if (!effectDoc) return null;
    await target.actor.createEmbeddedDocuments("Item", [effectDoc.toObject()]);
    return effectDoc.name;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
    });
  }
}

/**
 * The single-target healing-direction execution for a #174-scoped
 * dual-nature spell (`castDualHeal`) — structurally identical to #132's
 * `castHealSpellAndApply` (same manual roll-total-negation technique;
 * confirmed live directly for #174 that BOTH opposite-polarity healing
 * cases, Harm-heals-undead and Heal-heals-living, hit the exact same
 * ambiguous-`kinds` no-op the standard roll-object `applyDamage` path
 * always produces for a healing-direction roll, spell-trait-agnostic — not
 * kept as a single shared helper with #132's version only because that
 * function is already shipped and tested on its own narrower contract;
 * this one adds the tier's own flat `bonus` (#174's 2-action "+8" clause,
 * confirmed live only ever attached to a single-target healing tier, never
 * the area tier) before negating.
 */
async function castDualHealAndApply(
  combatant,
  target,
  spellId,
  entryId,
  bonus,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    const targetRef = { document: target.token };
    await entry.cast(spell, { target: targetRef, createMessage: true });
    const healRoll = await spell.rollDamage?.({
      target: targetRef,
      createMessage: true,
    });
    if (healRoll?.total != null) {
      await target.actor.applyDamage({
        damage: -(healRoll.total + bonus),
        token: target.token,
      });
    }
    return healRoll?.total != null ? healRoll.total + bonus : null;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * The 3-action area-tier execution for a #174-scoped dual-nature spell
 * (`castDualArea`) — casts once (no single target, matching #119/#140's
 * area-cast convention), then applies BOTH effects within the same cast:
 * `harmTargets` roll their own basic Fortitude save and take
 * outcome-scaled damage via the standard roll-object `applyDamage` path
 * (confirmed live this works correctly for the damage direction
 * regardless of which spell/target-type combination produces it, and
 * `spell.rollDamage({target,outcome,...})` already applies basic-save
 * halving/doubling internally — no manual `.alter()` needed, unlike #140's
 * spells, since Harm/Heal's damage magnitude never varies by tier at all);
 * `healTargets` get no save at all (confirmed live from the spell's own
 * text - "restore that amount of Hit Points", no outcome dependency) and
 * use #132's manual negation technique, with no bonus (the tier's own
 * "+8" clause is confirmed live to never attach to the area tier).
 */
export async function castDualAreaAndApply(
  combatant,
  harmTargets,
  healTargets,
  spellId,
  entryId,
  save,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    await entry.cast(spell, { createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    const outcomes = [];
    for (const target of harmTargets) {
      const saveStat = target.actor?.saves?.[save];
      if (!saveStat) continue;
      const targetRef = { document: target.token };
      await saveStat.roll({ dc: { value: dc }, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      playSpellSaveSound(outcome);
      const damageRoll = await spell.rollDamage?.({
        target: targetRef,
        outcome,
        createMessage: true,
      });
      await applyBasicSaveDamage(damageRoll, outcome, target);
      outcomes.push({ targetId: target.id, effect: "harm", outcome });
    }
    for (const target of healTargets) {
      const targetRef = { document: target.token };
      const healRoll = await spell.rollDamage?.({
        target: targetRef,
        createMessage: true,
      });
      if (healRoll?.total != null) {
        await target.actor.applyDamage({
          damage: -healRoll.total,
          token: target.token,
        });
      }
      outcomes.push({
        targetId: target.id,
        effect: "heal",
        healed: healRoll?.total ?? null,
      });
    }
    return outcomes;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Executes a #175-scoped target-count-scaling spell (`castTargetCount`,
 * Rebuke Death-shaped) against `targets` (already pre-selected — up to N
 * neediest-first, per live discussion) — one cast announcement (matching
 * #127's chain-spell convention: `entry.cast()` once, referencing the
 * first target, since this is mechanically ONE casting action reaching
 * multiple creatures, not N separate casts), then each target's own
 * effect resolved independently (a fresh roll per target, not one shared
 * roll reused across all of them, avoiding both the IWR-breaking bug
 * #127's own doc comment already flags for a shared-roll approach *and* a
 * more basic correctness bug: each target should get its own random
 * result, not everyone taking an identical amount). Branches on whether
 * `save` is present: Rebuke Death itself has no save at all (confirmed
 * live — pure healing, `defense: null`) and always takes the heal branch,
 * using the manual negate-and-pass-a-number technique (confirmed live
 * essential here too — `applyDamage(rollObject)` damaged the target
 * instead of healing it, despite the roll's own `kinds` being an
 * *unambiguous* `["healing"]`, refining #132's original theory: the
 * roll-object path is never correct for healing, regardless of what its
 * `kinds` say). The save branch exists for a hypothetical non-healing
 * target-count spell (no real example exists today, but the scope filter
 * doesn't assume healing), mirroring #118/#127's standard save-and-apply
 * pattern, already IWR-correct via the real `DamageRoll` object.
 */
export async function castTargetCountSpellAndApply(
  combatant,
  targets,
  spellId,
  entryId,
  save,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell || !targets.length) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    const primaryRef = { document: targets[0].token };
    await entry.cast(spell, { target: primaryRef, createMessage: true });
    const dc = entry.statistic?.dc?.value ?? 10;
    const outcomes = [];
    for (const target of targets) {
      const targetRef = { document: target.token };
      if (save) {
        const saveStat = target.actor?.saves?.[save];
        if (!saveStat) continue;
        await saveStat.roll({ dc: { value: dc }, createMessage: true });
        const outcome =
          game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
        playSpellSaveSound(outcome);
        const damageRoll = await spell.rollDamage?.({
          target: targetRef,
          outcome,
          createMessage: true,
        });
        await applyBasicSaveDamage(damageRoll, outcome, target);
        outcomes.push({ targetId: target.id, outcome });
      } else {
        const healRoll = await spell.rollDamage?.({
          target: targetRef,
          createMessage: true,
        });
        if (healRoll?.total != null) {
          await target.actor.applyDamage({
            damage: -healRoll.total,
            token: target.token,
          });
        }
        outcomes.push({ targetId: target.id, healed: healRoll?.total ?? null });
      }
    }
    return outcomes;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Executes a #176-scoped auto-hit-at-max-tier area spell at the cost tier
 * matching `cost` — save-scaled damage for an ordinary tier (manually
 * constructing a `DamageRoll` per target and `.alter()`-scaling it by
 * outcome, exactly #140's established pattern, since `spell.rollDamage()`
 * doesn't scale by action-count tier here either), or, when the resolved
 * tier is flagged `noSave`, a flat unconditional `DamageRoll` built from a
 * plain numeric formula (`"(20)[force]"` — confirmed live in #140's own
 * research this is the correct single-instance IWR-respecting shape for a
 * fixed, non-dice amount) applied to every target with no save roll at
 * all, matching Force Rain's own "don't attempt a saving throw" text.
 */
async function castAutoHitAreaSpellAndApplyDamage(
  combatant,
  targets,
  spellId,
  entryId,
  save,
  cost,
) {
  const entry = combatant.actor?.spellcasting?.contents?.find(
    (e) => e.id === entryId,
  );
  const spell = entry?.spells?.contents?.find((s) => s.id === spellId);
  if (!entry || !spell) return null;
  const tier = resolveAutoHitAreaTiers(spell)[cost];
  if (!tier) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    await entry.cast(spell, { createMessage: true });
    const DamageRollClass = CONFIG.Dice.rolls.find(
      (c) => c.name === "DamageRoll",
    );
    const outcomes = [];
    if (tier.noSave) {
      for (const target of targets) {
        const roll = new DamageRollClass(
          `(${tier.flatDamage})[${tier.damageType}]`,
        );
        await roll.evaluate();
        await target.actor.applyDamage({ damage: roll, token: target.token });
        await applyDefeatIfReducedToZero(target);
        outcomes.push({ targetId: target.id, total: roll.total });
      }
    } else {
      const dc = entry.statistic?.dc?.value ?? 10;
      const formula = tier.damage
        .map((d) => `(${d.formula})[${d.type}]`)
        .join(",");
      for (const target of targets) {
        const saveStat = target.actor?.saves?.[save];
        if (!saveStat) continue;
        const targetRef = { document: target.token };
        await saveStat.roll({ dc: { value: dc }, createMessage: true });
        const outcome =
          game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
        playSpellSaveSound(outcome);
        if (outcome !== "criticalSuccess") {
          const roll = new DamageRollClass(formula);
          await roll.evaluate();
          const scaled =
            outcome === "success"
              ? await roll.alter(0.5, 0)
              : outcome === "criticalFailure"
                ? await roll.alter(2, 0)
                : roll;
          await target.actor.applyDamage({
            damage: scaled,
            token: target.token,
            outcome,
          });
          await applyDefeatIfReducedToZero(target);
        }
        outcomes.push({ targetId: target.id, outcome });
      }
    }
    return outcomes;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/**
 * Rolls each of `targets`' own saves against `dc` and applies
 * basic-save-scaled damage on any outcome but a critical success, then
 * records the ability's recharge timer. Unlike every spell execution
 * function so far, there's no `entry.cast()` announcement step (a plain
 * action item has no spellcasting entry) and no `spell.rollDamage()` to
 * lean on for outcome-scaled damage (confirmed live a plain action item
 * has neither method) — so this constructs a real `DamageRoll` directly
 * (`CONFIG.Dice.rolls`'s registered class, formula `"(NdM)[type]"`, so the
 * target's resistances/weaknesses to `damageType` are still respected via
 * `applyDamage`'s IWR pipeline — confirmed live a plain number bypasses
 * that pipeline entirely) and scales it with the roll's own `.alter(mult,
 * 0)` method (confirmed live this correctly preserves per-type instance
 * data, not just the top-level total, and rounds a half down exactly like
 * PF2e's own "half damage" rule).
 */
async function castBreathWeaponAndApplyDamage(
  combat,
  combatant,
  targets,
  itemId,
  damageFormula,
  damageType,
  save,
  dc,
  rechargeFormula,
) {
  const item = combatant.actor?.items?.get(itemId);
  if (!item) return null;

  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
  });
  try {
    const DamageRollClass = CONFIG.Dice.rolls.find(
      (c) => c.name === "DamageRoll",
    );
    const outcomes = [];
    for (const target of targets) {
      const saveStat = target.actor?.saves?.[save];
      if (!saveStat) continue;
      await saveStat.roll({ dc: { value: dc }, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      if (outcome !== "criticalSuccess") {
        const roll = new DamageRollClass(`(${damageFormula})[${damageType}]`);
        await roll.evaluate();
        const scaled =
          outcome === "success"
            ? await roll.alter(0.5, 0)
            : outcome === "criticalFailure"
              ? await roll.alter(2, 0)
              : roll;
        await target.actor.applyDamage({
          damage: scaled,
          token: target.token,
          outcome,
        });
        await applyDefeatIfReducedToZero(target);
      }
      outcomes.push({ targetId: target.id, outcome });
    }
    await setAbilityRecharge(
      combat,
      combatant.id,
      actionItemSlug(item),
      rechargeFormula,
    );
    return outcomes;
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
    });
  }
}

/** #909: upper bound on waiting for a maneuver macro's callback. The
 * macro never returns its own promise and never calls `callback` when its
 * check can't be rolled at all (e.g. a CheckContextError for a missing
 * statistic, which it only reports via ui.notifications) -- without this,
 * that case would hang the agent's turn forever. */
const MANEUVER_CHECK_TIMEOUT_MS = 30000;

/**
 * #909: game.pf2e.actions.<slug>() (trip/shove/grapple/disarm/demoralize)
 * is fire-and-forget -- confirmed in the installed system's bundled source,
 * none of the five action functions `return` their own
 * simpleRollActionCheck(...) promise. The only way to know the roll
 * finished is the `callback` option, so this bridges that callback to a
 * promise. Resolves `null` if no outcome arrives in time or the macro
 * throws synchronously. `modifiers` is passed straight through to the
 * macro's own check (the hook a multiple attack penalty for the four
 * attack-trait maneuvers will use, #940). `skill` (#911) overrides the
 * statistic rolled; omitted, the macro uses the maneuver's base skill.
 */
function runManeuverCheck(slug, combatant, target, { modifiers, skill } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome ?? null);
    };
    const timer = setTimeout(() => finish(null), MANEUVER_CHECK_TIMEOUT_MS);
    try {
      // The macro's default string-slug DC is not resolved against our
      // synthetic target in this system build, so pass a numeric DC.
      let dcValue = null;
      try {
        const dcSlug = MANEUVER_DEFS[slug]?.dcSlug;
        dcValue = dcSlug ? target.actor?.getStatistic?.(dcSlug)?.dc?.value : null;
      } catch {
        dcValue = null;
      }
      game.pf2e.actions[slug]({
        actors: [combatant.actor],
        target: () => ({ actor: target.actor, token: target.token }),
        event: null,
        ...(Number.isFinite(dcValue) ? { difficultyClass: { value: dcValue } } : {}),
        ...(modifiers?.length ? { modifiers } : {}),
        // #911: a feat-substituted statistic (Sly Disarm: Thievery) goes
        // through the macro's own `skill` option; the DC above is still the
        // maneuver's own defense (Disarm: Reflex) regardless of the skill.
        ...(skill ? { skill } : {}),
        callback: ({ outcome }) => finish(outcome),
      });
    } catch (err) {
      console.error(`#909: ${slug} maneuver macro failed:`, err.message);
      finish(null);
    }
  });
}

/** #911: tracks a module-applied maneuver rider condition for removal by
 * sweepExpiredManeuverRiders. Same combat-flag precedent as the recharge
 * tracking (`availableAtRound`) and demoralizeImmunity. */
async function recordManeuverRiderExpiry(combat, entry) {
  const current = combat.getFlag(MODULE_ID, "maneuverRiderExpiry") ?? [];
  await combat.setFlag(MODULE_ID, "maneuverRiderExpiry", [...current, entry]);
}

/** #911: whether a tracked rider has run out at the combat's current
 * (round, turn). `untilRoundTurn` ("for 1 round": Terrified Retreat's
 * Fleeing) ends once that (round, turn) is reached or passed;
 * `afterRoundTurn` ("before the end of your turn": Sly Disarm's Off-Guard)
 * ends the moment the current (round, turn) differs from the granting one.
 * A malformed entry counts as expired so it never lingers. */
function maneuverRiderExpired(combat, expiry) {
  const round = combat.round ?? 0;
  const turn = combat.turn ?? 0;
  if (expiry?.untilRoundTurn) {
    const { round: r, turn: t } = expiry.untilRoundTurn;
    return round > r || (round === r && turn >= t);
  }
  if (expiry?.afterRoundTurn) {
    const { round: r, turn: t } = expiry.afterRoundTurn;
    return round !== r || turn !== t;
  }
  return true;
}

/** #911: PF2e's Fleeing condition item carries no duration at all
 * (`duration: {unit: "unlimited"}`), and Sly Disarm's turn-limited
 * Off-Guard has no system-tracked duration either -- this module removes
 * both itself on turn/round change (module.mjs's updateCombat hook). GM
 * only, since that hook fires on every client. A removal that fails is
 * logged and the entry dropped; it never aborts the rest of the sweep. */
export async function sweepExpiredManeuverRiders(combat) {
  if (globalThis.game?.user && !game.user.isGM) return;
  if (typeof combat?.getFlag !== "function") return;
  const entries = combat.getFlag(MODULE_ID, "maneuverRiderExpiry") ?? [];
  if (!Array.isArray(entries) || !entries.length) return;
  const remaining = [];
  for (const entry of entries) {
    if (!maneuverRiderExpired(combat, entry?.expiry)) {
      remaining.push(entry);
      continue;
    }
    if (!entry?.targetId || !entry?.conditionSlug) continue;
    try {
      const target = Array.from(combat.combatants ?? []).find((c) => c.id === entry.targetId);
      await target?.actor?.decreaseCondition?.(entry.conditionSlug, { forceRemove: true });
    } catch (err) {
      console.error(`${MODULE_ID} | #911: removing expired ${entry.conditionSlug} failed:`, err.message);
    }
  }
  if (remaining.length !== entries.length) {
    await combat.setFlag(MODULE_ID, "maneuverRiderExpiry", remaining);
  }
}

/** #943: PF2e RAW -- "at the end of each of your turns, the value of your
 * frightened condition decreases by 1." The pf2e system (8.5.0) does not
 * do this itself: ConditionPF2e#onEndTurn only acts on persistent damage.
 * Called from module.mjs's `pf2e.endTurn` hook for every combatant, player-
 * or AI-controlled. `actor.decreaseCondition("frightened")` drops a valued
 * condition by 1 and deletes it at 0. Never throws: a failure is logged so
 * it can't break other `pf2e.endTurn` listeners. */
export async function decayFrightenedAtEndOfTurn(combatant) {
  const actor = combatant?.actor;
  if (!actor) return;
  try {
    const condition = actor.getCondition("frightened");
    if (!condition) return;
    // #920: Antagonize holds Frightened at 1 while any antagonizer's floor
    // lasts (antagonize.mjs).
    const floor = frightenedFloorFor(actor);
    if ((condition.value ?? 0) <= floor) {
      if (floor > 0) await whisperAntagonize(`${actor.name}'s Frightened stays at ${floor} (Antagonize).`);
      return;
    }
    await actor.decreaseCondition("frightened");
  } catch (err) {
    console.error(`${MODULE_ID} | #943: Frightened end-of-turn decay failed:`, err?.message);
  }
}

/** #920: true on the one client that should mutate state from a global
 * hook (the active GM), matching the #616/#943 gates. */
function isActiveGmClient() {
  return game.users?.activeGM?.isSelf ?? game.user?.isGM ?? false;
}

/** #920: a best-effort GM whisper about an Antagonize floor; never throws. */
async function whisperAntagonize(text) {
  try {
    const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
    await whisperGmContent(`<p><strong>Antagonize:</strong> ${esc(text)}</p>`);
  } catch (err) {
    console.error(`${MODULE_ID} | #920: Antagonize report failed:`, err?.message);
  }
}

/** #920: the combatant in `combat` with id `id` (an EmbeddedCollection or a
 * plain array alike). */
function combatantById(combat, id) {
  return Array.from(combat?.combatants ?? []).find((c) => c.id === id) ?? null;
}

/** #920: records `antagonizer`'s Antagonize floor on `target` after a
 * successful Demoralize -- only when the antagonizer really has the feat
 * (slug `antagonize`). Keyed by the antagonizer's combatant id (see
 * antagonize.mjs); a repeat Demoralize by the same antagonizer restarts its
 * entry. Returns whether a floor was recorded. A failed write is logged and
 * reported; it never affects the Demoralize result itself. */
export async function recordAntagonizeFloor(antagonizer, target) {
  const actor = target?.actor;
  if (!antagonizer?.id || !actor || antagonizer.id === target.id) return false;
  if (!actorFeatSlugs(antagonizer.actor).includes(ANTAGONIZE_FEAT_SLUG)) return false;
  try {
    await actor.setFlag(MODULE_ID, `antagonize.${antagonizer.id}`, {
      antagonizerUuid: antagonizer.actor?.uuid ?? null,
      sinceWorldTime: game.time?.worldTime ?? 0,
      unsensedSince: null,
    });
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | #920: recording an Antagonize floor failed:`, err?.message);
    await whisperAntagonize(
      `could not record ${antagonizer.name}'s floor on ${target.name} -- keep its Frightened at 1 by hand.`,
    );
    return false;
  }
}

/** #920: removes the given antagonizers' entries from `frightened`'s map
 * (the whole flag when none would remain) and reports each, naming why. */
async function removeAntagonizeEntries(combat, frightened, ids, reason) {
  const actor = frightened?.actor;
  const map = readAntagonizeMap(actor);
  const removing = ids.filter((id) => Object.hasOwn(map, id));
  if (!removing.length) return;
  try {
    if (removing.length === Object.keys(map).length) {
      await actor.unsetFlag(MODULE_ID, "antagonize");
    } else {
      for (const id of removing) await actor.unsetFlag(MODULE_ID, `antagonize.${id}`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | #920: clearing an Antagonize floor failed:`, err?.message);
    return;
  }
  for (const id of removing) {
    const name = combatantById(combat, id)?.name ?? "its antagonizer";
    await whisperAntagonize(`${frightened.name}'s floor from ${name} ends (${reason}).`);
  }
}

/** #920: the frightened creature `frightened` used a hostile action against
 * the combatants `targetIds`; each of those that holds an Antagonize floor on
 * it loses that floor. Others' floors are untouched. */
export async function clearAntagonizeOnHostileAction(combat, frightened, targetIds) {
  try {
    await removeAntagonizeEntries(combat, frightened, targetIds ?? [], "it used a hostile action against them");
  } catch (err) {
    console.error(`${MODULE_ID} | #920: Antagonize hostile-action clear failed:`, err?.message);
  }
}

/** #920: the combat holding a combatant for `tokenId`, and that combatant. */
function findCombatantByTokenId(tokenId) {
  if (!tokenId) return null;
  for (const combat of game.combats?.contents ?? []) {
    const combatant = Array.from(combat.combatants ?? []).find((c) => c.tokenId === tokenId);
    if (combatant) return { combat, combatant };
  }
  return null;
}

/** The trailing token-document id of a token UUID ("Scene.<id>.Token.<id>"),
 * which is what `Combatant#tokenId` carries. */
function tokenIdFromUuid(uuid) {
  return typeof uuid === "string" && uuid ? uuid.split(".").pop() : null;
}

/** #920: creates an Antagonize floor from a Demoralize check rolled through
 * the system's own action with a target (a player's roll): the message's
 * `flags.pf2e.context` then carries `options` with `action:demoralize`, the
 * `outcome` and `target.token`. The AI's own Demoralize (#909) rolls with a
 * numeric DC, so the system records no target for it (confirmed live: every
 * agent Demoralize message has `context.target === null`); that path records
 * its floor in applyBaseManeuverOutcome instead. Registered against
 * `createChatMessage` in module.mjs; never throws. */
export async function handleDemoralizeForAntagonize(message) {
  try {
    if (!isActiveGmClient()) return;
    const context = message?.flags?.pf2e?.context;
    if (context?.type !== "skill-check") return;
    if (!context.options?.includes("action:demoralize")) return;
    if (context.outcome !== "success" && context.outcome !== "criticalSuccess") return;
    const found = findCombatantByTokenId(message.speaker?.token);
    if (!found) return;
    const targetTokenId = tokenIdFromUuid(context.target?.token);
    const target = Array.from(found.combat.combatants ?? []).find((c) => c.tokenId === targetTokenId);
    if (!target) return;
    if (await recordAntagonizeFloor(found.combatant, target)) {
      await whisperAntagonize(
        `${target.name}'s Frightened can't fall below 1 while ${found.combatant.name} holds it.`,
      );
    }
  } catch (err) {
    console.error(`${MODULE_ID} | #920: Antagonize Demoralize handler failed:`, err?.message);
  }
}

/** #920: ends a floor when the frightened creature uses a hostile action
 * against its antagonizer, as seen in a chat message: an attack, spell
 * attack or damage roll, or a hostile skill check (antagonize.mjs
 * isHostileCheckContext) the creature rolled against the antagonizer
 * (`context.target`); or a saving throw the antagonizer rolled against an
 * effect whose `context.origin` is the creature. Registered against
 * `createChatMessage` in module.mjs; never throws. */
export async function handleAntagonizeHostileMessage(message) {
  try {
    if (!isActiveGmClient()) return;
    const context = message?.flags?.pf2e?.context;
    if (!context) return;
    let actorTokenId;
    let victimTokenId;
    if (context.type === "saving-throw") {
      actorTokenId = tokenIdFromUuid(context.origin?.token);
      victimTokenId = message.speaker?.token;
    } else if (isHostileCheckContext(context)) {
      actorTokenId = message.speaker?.token;
      victimTokenId = tokenIdFromUuid(context.target?.token);
    } else {
      return;
    }
    if (!actorTokenId || !victimTokenId || actorTokenId === victimTokenId) return;
    const found = findCombatantByTokenId(actorTokenId);
    if (!found) return;
    const victim = Array.from(found.combat.combatants ?? []).find((c) => c.tokenId === victimTokenId);
    if (!victim) return;
    await clearAntagonizeOnHostileAction(found.combat, found.combatant, [victim.id]);
  } catch (err) {
    console.error(`${MODULE_ID} | #920: Antagonize hostile-action handler failed:`, err?.message);
  }
}

/** #920: at every turn change (module.mjs's updateCombat hook), for each
 * combatant holding Antagonize floors: drop them all once it is defeated or
 * no longer Frightened; drop one whose antagonizer is gone or defeated; and
 * sample whether it still senses each antagonizer (the #616 detection
 * matrix: hidden still counts as sensed), dropping a floor once a full round
 * has passed without sensing (antagonize.mjs evaluateAntagonizeEntry). A
 * failure for one combatant is logged and leaves its floors untouched. */
export async function sweepAntagonizeFloors(combat) {
  if (!isActiveGmClient()) return;
  const matrix = combat?.getFlag?.(MODULE_ID, "detection") ?? null;
  const round = combat?.round ?? 0;
  const turn = combat?.turn ?? 0;
  for (const combatant of Array.from(combat?.combatants ?? [])) {
    const map = readAntagonizeMap(combatant.actor);
    const ids = Object.keys(map);
    if (!ids.length) continue;
    try {
      if (combatant.isDefeated) {
        await removeAntagonizeEntries(combat, combatant, ids, "it is defeated");
        continue;
      }
      if (!combatant.actor.getCondition?.("frightened")) {
        await removeAntagonizeEntries(combat, combatant, ids, "it is no longer Frightened");
        continue;
      }
      const gone = [];
      const lostSense = [];
      for (const id of ids) {
        const antagonizer = combatantById(combat, id);
        if (!antagonizer || antagonizer.isDefeated) {
          gone.push(id);
          continue;
        }
        const state = matrix ? stateFor(matrix, antagonizer.id, combatant.id) : undefined;
        const { entry, expired } = evaluateAntagonizeEntry(map[id], {
          sensed: sensesAntagonizer(state),
          round,
          turn,
        });
        if (expired) {
          lostSense.push(id);
        } else if (JSON.stringify(entry.unsensedSince ?? null) !== JSON.stringify(map[id].unsensedSince ?? null)) {
          await combatant.actor.setFlag(MODULE_ID, `antagonize.${id}.unsensedSince`, entry.unsensedSince);
        }
      }
      if (gone.length) await removeAntagonizeEntries(combat, combatant, gone, "the antagonizer is defeated or gone");
      if (lostSense.length) {
        await removeAntagonizeEntries(combat, combatant, lostSense, "it could not observe or sense them for a round");
      }
    } catch (err) {
      console.error(`${MODULE_ID} | #920: Antagonize sense sweep failed for ${combatant.name}:`, err?.message);
    }
  }
}

/** #920: a deleted Frightened condition takes its Antagonize floors with it
 * (the floor only constrains that condition; a later, unrelated Frightened
 * must decay normally). Registered against `deleteItem` in module.mjs. */
export async function handleFrightenedRemovedForAntagonize(item) {
  try {
    if (!isActiveGmClient()) return;
    if (item?.type !== "condition" || item.slug !== "frightened") return;
    const actor = item.actor ?? item.parent;
    if (!Object.keys(readAntagonizeMap(actor)).length) return;
    if (actor.getCondition?.("frightened")) return;
    await actor.unsetFlag(MODULE_ID, "antagonize");
  } catch (err) {
    console.error(`${MODULE_ID} | #920: Antagonize Frightened-removal clear failed:`, err?.message);
  }
}

/** #933: module.mjs's `deleteItem` hook -- a Grabbed/Restrained condition
 * leaving an actor (Escape, the GM, a release) ends the grab records that
 * target it in every combat (dungeon-strike-riders.mjs). The records live
 * on the Combat document, so a combat's end needs no cleanup of its own. */
export async function handleGrabConditionRemovedForGrabState(item) {
  await handleGrabConditionRemoved(item, {
    combats: Array.from(game.combats?.contents ?? []),
    isGm: isActiveGmClient(),
  });
}

/** #920: a deleted combat ends every Antagonize floor its combatants hold --
 * entries are keyed by this combat's combatant ids and sensing is only
 * tracked during combat. Called from module.mjs's deleteCombat hook. */
export async function clearAntagonizeForCombat(combat) {
  for (const combatant of Array.from(combat?.combatants ?? [])) {
    const actor = combatant?.actor;
    if (!Object.keys(readAntagonizeMap(actor)).length) continue;
    try {
      await actor.unsetFlag(MODULE_ID, "antagonize");
    } catch (err) {
      console.error(`${MODULE_ID} | #920: clearing Antagonize floors at combat end failed:`, err?.message);
    }
  }
}

/** #915: an NPC ability's "temporarily immune ... for N" window, as a
 * game-clock (worldTime) timestamp keyed by ability item then target --
 * the same shape #909's demoralizeImmunity uses. 0 when never recorded. */
export function getNpcAbilityImmunityUntil(combat, itemId, targetId) {
  return combat.getFlag(MODULE_ID, "npcAbilityImmunity")?.[itemId]?.[targetId] ?? 0;
}

export async function setNpcAbilityImmunityUntil(combat, itemId, targetId, worldTimeExpiry) {
  const current = combat.getFlag(MODULE_ID, "npcAbilityImmunity") ?? {};
  await combat.setFlag(MODULE_ID, "npcAbilityImmunity", {
    ...current,
    [itemId]: { ...(current[itemId] ?? {}), [targetId]: worldTimeExpiry },
  });
}

/** #915: tracks a condition an NPC ability applied with a duration, for
 * sweepExpiredNpcAbilityConditions. A sibling of #911's
 * recordManeuverRiderExpiry under its own flag (same entry/expiry shapes),
 * plus `expiresAtWorldTime` for the end-of-combat settle. */
async function recordNpcAbilityExpiry(combat, entry) {
  const current = combat.getFlag(MODULE_ID, "npcAbilityExpiry") ?? [];
  await combat.setFlag(MODULE_ID, "npcAbilityExpiry", [...current, entry]);
}

async function removeTrackedCondition(combat, entry) {
  if (!entry?.targetId || !entry?.conditionSlug) return;
  try {
    const target = Array.from(combat.combatants ?? []).find((c) => c.id === entry.targetId);
    await target?.actor?.decreaseCondition?.(entry.conditionSlug, { forceRemove: true });
  } catch (err) {
    console.error(`${MODULE_ID} | #915: removing expired ${entry.conditionSlug} failed:`, err.message);
  }
}

/** #915: removes NPC-ability conditions whose duration ran out at this
 * (round, turn) -- PF2e condition items carry no duration of their own, so
 * the module removes them, exactly as #911 does for maneuver riders
 * (module.mjs's updateCombat hook, GM only). A failed removal is logged and
 * its entry dropped; it never aborts the rest of the sweep. */
export async function sweepExpiredNpcAbilityConditions(combat) {
  if (globalThis.game?.user && !game.user.isGM) return;
  if (typeof combat?.getFlag !== "function") return;
  const entries = combat.getFlag(MODULE_ID, "npcAbilityExpiry") ?? [];
  if (!Array.isArray(entries) || !entries.length) return;
  const remaining = [];
  for (const entry of entries) {
    if (!npcAbilityConditionExpired(combat, entry)) {
      remaining.push(entry);
      continue;
    }
    await removeTrackedCondition(combat, entry);
  }
  if (remaining.length !== entries.length) {
    await combat.setFlag(MODULE_ID, "npcAbilityExpiry", remaining);
  }
}

/** #933: whether the target of a tracked `whileCondition` entry no longer
 * carries that condition (Gnaw's Slowed ends once Sickened is gone). A
 * target that left the combat counts as expired. */
function whileConditionEnded(combat, entry) {
  const target = Array.from(combat.combatants ?? []).find((c) => c.id === entry?.targetId);
  if (!target?.actor) return true;
  return !Array.from(target.actor.conditions ?? []).some((c) => c?.slug === entry.expiry.whileCondition);
}

function npcAbilityConditionExpired(combat, entry) {
  if (entry?.expiry?.whileCondition) return whileConditionEnded(combat, entry);
  return maneuverRiderExpired(combat, entry?.expiry);
}

function remainingTimeLabel(seconds) {
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.max(1, Math.ceil(seconds))} seconds`;
}

/** #915: when a combat ends, a condition whose duration is turn-scoped or
 * already over on the game clock is removed; one that still has time left
 * (a "for 1 hour" Stupefied) is left on the creature and the GM is whispered
 * what remains, rather than silently dropping or orphaning it. */
export async function settleNpcAbilityConditionsAtCombatEnd(combat) {
  if (typeof combat?.getFlag !== "function") return;
  const entries = combat.getFlag(MODULE_ID, "npcAbilityExpiry") ?? [];
  if (!Array.isArray(entries) || !entries.length) return;
  const now = globalThis.game?.time?.worldTime ?? 0;
  const lingering = [];
  const linked = [];
  for (const entry of entries) {
    const end = entry?.expiresAtWorldTime;
    if (entry?.expiry?.whileCondition) {
      // #933: lasts as long as another condition -- still running if that
      // one is.
      if (whileConditionEnded(combat, entry)) await removeTrackedCondition(combat, entry);
      else linked.push(entry);
    } else if (typeof end === "number" && end > now) lingering.push(entry);
    else await removeTrackedCondition(combat, entry);
  }
  if (linked.length) {
    const escLinked = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
    const items = linked.map((entry) => {
      const name = Array.from(combat.combatants ?? []).find((c) => c.id === entry.targetId)?.name ?? entry.targetId;
      return `<li>${escLinked(name)}: ${escLinked(entry.conditionSlug)} (while ${escLinked(entry.expiry.whileCondition)}${entry.source ? `, ${escLinked(entry.source)}` : ""})</li>`;
    });
    await whisperGmContent(
      `<p><strong>Monster ability conditions tied to another condition:</strong> remove each when that condition ends.</p><ul>${items.join("")}</ul>`,
    );
  }
  if (!lingering.length) return;
  const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
  const lines = lingering.map((entry) => {
    const name = Array.from(combat.combatants ?? []).find((c) => c.id === entry.targetId)?.name ?? entry.targetId;
    return `<li>${esc(name)}: ${esc(entry.conditionSlug)} (${esc(remainingTimeLabel(entry.expiresAtWorldTime - now))} left${entry.source ? `, ${esc(entry.source)}` : ""})</li>`;
  });
  await whisperGmContent(
    `<p><strong>Monster ability conditions still running:</strong> remove each by hand when its time is up.</p><ul>${lines.join("")}</ul>`,
  );
}

/** #909: Disarm's critical success -- "the item falls to the ground in the
 * target's space": the target's first held item stops being held. */
async function dropHeldItem(actor) {
  const item = Array.from(actor?.items ?? []).find(
    (i) => i?.system?.equipped?.carryType === "held",
  );
  if (!item) return null;
  await item.update({
    "system.equipped.carryType": "dropped",
    "system.equipped.handsHeld": 0,
  });
  return item;
}

/** PF2e RAW outcome table for the five basic maneuvers, verbatim from the
 * installed system's lang/action-en.json (see this feature's spec) -- none
 * of the five macros auto-apply their own outcome, so every effect here is
 * applied by hand, mirroring dungeon-strike-riders.mjs's
 * applyConditionOnSuccess precedent. Returns a short description for the
 * GM whisper. */
async function applyManeuverOutcome(slug, combat, combatant, target, outcome, skillUsed = MANEUVER_DEFS[slug]?.skill) {
  const base = await applyBaseManeuverOutcome(slug, combat, combatant, target, outcome);
  // #911: feat riders land after (and never undo) the base RAW outcome.
  const riders = await applyManeuverRiders(combat, combatant, target, slug, outcome, skillUsed);
  return [base, ...riders].join("; ");
}

/** The base RAW consequence of one maneuver outcome (see applyManeuverOutcome). */
async function applyBaseManeuverOutcome(slug, combat, combatant, target, outcome) {
  const hit = outcome === "success" || outcome === "criticalSuccess";
  if (slug === "trip") {
    if (hit) await target.actor.increaseCondition("prone");
    if (outcome === "criticalSuccess") {
      const DamageRollClass = CONFIG.Dice.rolls.find((c) => c.name === "DamageRoll");
      const roll = new DamageRollClass("1d6[bludgeoning]");
      await roll.evaluate();
      await target.actor.applyDamage({ damage: roll, token: target.token });
      await applyDefeatIfReducedToZero(target);
      return `target is Prone and takes ${roll.total} bludgeoning damage`;
    }
    if (hit) return "target is Prone";
    if (outcome === "criticalFailure") {
      await combatant.actor.increaseCondition("prone");
      return "attacker falls Prone";
    }
  } else if (slug === "shove") {
    if (hit) {
      const squares = outcome === "criticalSuccess" ? 2 : 1;
      await pushTokenAway(combat, combatant, target, squares);
      return `target pushed ${squares * 5} ft`;
    }
    if (outcome === "criticalFailure") {
      await combatant.actor.increaseCondition("prone");
      return "attacker falls Prone";
    }
  } else if (slug === "grapple") {
    if (outcome === "criticalSuccess") {
      await target.actor.increaseCondition("restrained");
      await recordGrab(combat, combatant, target);
      return "target is Restrained";
    }
    if (outcome === "success") {
      await target.actor.increaseCondition("grabbed");
      await recordGrab(combat, combatant, target);
      return "target is Grabbed";
    }
  } else if (slug === "disarm") {
    if (outcome === "criticalSuccess") {
      const item = await dropHeldItem(target.actor);
      return item ? `${item.name} falls to the ground` : "target holds nothing to drop";
    }
    if (outcome === "success") {
      const effect = await fromUuid("Compendium.pf2e.other-effects.Item.PuDS0DEq0CnaSIFV");
      if (effect) await target.actor.createEmbeddedDocuments("Item", [effect.toObject()]);
      return "target's grip is weakened";
    }
    if (outcome === "criticalFailure") {
      await combatant.actor.increaseCondition("off-guard");
      return "attacker is Off-Guard";
    }
  } else if (slug === "demoralize") {
    // RAW: regardless of the result, the target is immune to this
    // attacker's Demoralize for 10 minutes -- real game time (#785 clock).
    await setDemoralizeImmunityUntil(
      combat,
      combatant.id,
      target.id,
      game.time.worldTime + 600,
    );
    if (hit) {
      const value = outcome === "criticalSuccess" ? 2 : 1;
      await target.actor.increaseCondition("frightened", { value });
      // #920: the system records no target on this (numeric-DC) roll, so
      // the chat-message handler can't see it -- record the floor here.
      const antagonized = await recordAntagonizeFloor(combatant, target);
      return antagonized
        ? `target is Frightened ${value}; Antagonize: its Frightened can't fall below 1 while ${combatant.name} holds it`
        : `target is Frightened ${value}`;
    }
  }
  return "no effect";
}

/** #911: applies each feat rider ridersFor returns (Crushing Grab, Sly
 * Disarm, Terrified Retreat), after the base RAW outcome already landed.
 * A failing rider is caught, logged and reported in the returned GM text;
 * it never undoes or interrupts the base outcome. Returns one short
 * description per rider, naming the feat. */
async function applyManeuverRiders(combat, combatant, target, slug, outcome, skillUsed) {
  const riders = ridersFor(actorFeatSlugs(combatant.actor), slug, outcome, skillUsed, {
    actorLevel: combatant.actor?.level,
    targetLevel: target.actor?.level,
  });
  const notes = [];
  for (const rider of riders) {
    const feat = MANEUVER_RIDER_FEAT_NAMES[rider.type] ?? rider.type;
    try {
      if (rider.type === "crushingGrabDamage") {
        // "deal bludgeoning damage ... equal to your Strength modifier" --
        // a typed DamageRoll (not a bare number) so the target's
        // bludgeoning IWR applies, same as the Trip crit damage above.
        const mod = Number(combatant.actor?.abilities?.str?.mod);
        if (!Number.isFinite(mod) || mod <= 0) continue;
        const DamageRollClass = CONFIG.Dice.rolls.find((c) => c.name === "DamageRoll");
        const roll = new DamageRollClass(`${mod}[bludgeoning]`);
        await roll.evaluate();
        await target.actor.applyDamage({ damage: roll, token: target.token });
        await applyDefeatIfReducedToZero(target);
        notes.push(`${feat}: ${roll.total} bludgeoning damage`);
      } else if (rider.type === "slyDisarmOffGuard") {
        // "Off-Guard against the next attack you make before the end of
        // your turn" -- removed at this turn's end by the expiry sweep. A
        // condition the target already had is neither re-applied nor
        // tracked, so the sweep never strips someone else's Off-Guard.
        if (actorHasCondition(target.actor, "off-guard")) continue;
        await target.actor.increaseCondition("off-guard");
        await recordManeuverRiderExpiry(combat, {
          targetId: target.id,
          conditionSlug: "off-guard",
          expiry: { afterRoundTurn: { round: combat.round, turn: combat.turn } },
        });
        notes.push(`${feat}: target is Off-Guard until the end of this turn`);
      } else if (rider.type === "terrifiedRetreatFleeing") {
        // "Fleeing for 1 round" -- until this same point next round.
        if (actorHasCondition(target.actor, "fleeing")) continue;
        await target.actor.increaseCondition("fleeing");
        await recordManeuverRiderExpiry(combat, {
          targetId: target.id,
          conditionSlug: "fleeing",
          expiry: { untilRoundTurn: { round: combat.round + 1, turn: combat.turn } },
        });
        notes.push(`${feat}: target is Fleeing for 1 round`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | #911: maneuver rider (${rider.type}) failed:`, err.message);
      notes.push(`${feat} failed -- apply manually`);
    }
  }
  return notes;
}

const MANEUVER_RIDER_FEAT_NAMES = Object.freeze({
  crushingGrabDamage: "Crushing Grab",
  slyDisarmOffGuard: "Sly Disarm",
  terrifiedRetreatFleeing: "Terrified Retreat",
});

/** #940: whether `item` carries `trait` -- a real PF2e item exposes a
 * `traits` Set; a plain data object only `system.traits.value`. */
function itemHasTrait(item, trait) {
  if (typeof item?.traits?.has === "function") return item.traits.has(trait);
  return (item?.system?.traits?.value ?? []).includes(trait);
}

/** #940: the weapon the system's own maneuver macro will treat as the one
 * used for maneuver `slug`, or null for an unarmed/free-hand maneuver.
 * Mirrors ActionMacroHelpers.getBestEquippedItemForAction (private to the
 * system, so not callable from here): a character's ready strike actions
 * whose item has the trait (Trip also accepts `ranged-trip`), an NPC's
 * equipped weapons with it; on a tie the first wins. The system breaks
 * ties by weapon potency bonus; the potency rune is the stand-in here. */
function findManeuverWeapon(actor, slug) {
  const traits = slug === "trip" ? ["trip", "ranged-trip"] : [slug];
  const isCharacter =
    typeof actor?.isOfType === "function" ? actor.isOfType("character") : actor?.type === "character";
  const candidates = traits.flatMap((trait) =>
    isCharacter
      ? (actor?.system?.actions ?? []).flatMap((a) =>
          a?.ready && itemHasTrait(a.item, trait) ? [a.item] : [],
        )
      : (actor?.itemTypes?.weapon ?? []).filter((w) => w?.isEquipped && itemHasTrait(w, trait)),
  );
  const potency = (w) => w?.system?.runes?.potency ?? 0;
  return candidates.reduce((best, w) => (potency(w) > potency(best) ? w : best), candidates[0]) ?? null;
}

/**
 * #940: the multiple attack penalty modifier for an attack-trait maneuver
 * (Trip/Shove/Grapple/Disarm) at this turn's `mapIncrement`, or null when
 * none applies (the first attack of the turn, or Demoralize, which has no
 * attack trait). The system's maneuver macros forward a caller-supplied
 * `modifiers` array to the roll but add no MAP themselves, and its own
 * `calculateMAPs` is module-private (not on game.pf2e), so the values here
 * mirror it: -4/-8 when the maneuver's weapon is agile, else -5/-10 --
 * the same -5/-10 the system's Statistic#getChatData falls back to when
 * no item is involved (an unarmed/free-hand maneuver is never agile).
 * #919: the value comes from the pure maneuverMapPenalty, which also
 * applies the Agile Maneuvers feat (-4/-8, or -3/-6 with an agile weapon
 * and Panache); this function only gathers the actor-side inputs.
 * Rule-element MAP overrides (`synthetics.multipleAttackPenalties`) are
 * not applied.
 */
function computeManeuverMapModifier(actor, slug, mapIncrement) {
  if (!maneuverHasAttackTrait(slug) || !(mapIncrement > 0)) return null;
  const Modifier = game.pf2e?.Modifier;
  if (typeof Modifier !== "function") {
    console.warn(`#940: game.pf2e.Modifier unavailable -- ${slug} rolled without MAP`);
    return null;
  }
  const value = maneuverMapPenalty({
    attackNumber: mapIncrement + 1,
    weaponIsAgile: itemHasTrait(findManeuverWeapon(actor, slug), "agile"),
    featSlugs: actorFeatSlugs(actor),
    hasPanache: actorHasPanache(actor),
  });
  if (value === 0) return null;
  return new Modifier({
    slug: "multiple-attack-penalty",
    label: "PF2E.MultipleAttackPenalty",
    modifier: value,
    type: "untyped",
  });
}

/** #919: whether `actor` has panache -- the PF2e system tracks it as the
 * `effect-panache` effect item (confirmed live). Unreadable data reads as
 * no panache, never the more favorable value. */
function actorHasPanache(actor) {
  try {
    return Array.from(actor?.itemTypes?.effect ?? []).some((e) => e?.slug === "effect-panache");
  } catch {
    return false;
  }
}

/** #909: rolls and applies a chosen maneuver. #925: returns
 * `{ outcome, text, gmNote? }` for the AI turn card (which replaced this
 * function's own GM whisper), or null when the target is gone. */
async function executeManeuverCandidate(combat, combatant, candidate) {
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return null;
  // #940: the turn's attacks so far (Strikes, composite-feat Strikes and
  // attack-trait maneuvers, all counted by applyCandidateToTurnState).
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const mapModifier = computeManeuverMapModifier(combatant.actor, candidate.slug, mapIncrement);
  const outcome = await withDialogsSuppressed(() =>
    runManeuverCheck(candidate.slug, combatant, target, {
      skill: candidate.skill,
      ...(mapModifier ? { modifiers: [mapModifier] } : {}),
    }),
  );
  if (!outcome) {
    return { outcome: null, text: "no check result", gmNote: "No check result arrived -- resolve manually." };
  }
  const result = await applyManeuverOutcome(
    candidate.slug,
    combat,
    combatant,
    target,
    outcome,
    candidate.skill ?? MANEUVER_DEFS[candidate.slug]?.skill,
  );
  return { outcome, text: result };
}

/** #910: the action/feat item a feat candidate names, or null. */
function findFeatItem(actor, itemId) {
  return (
    [...(actor?.itemTypes?.action ?? []), ...(actor?.itemTypes?.feat ?? [])].find(
      (i) => i.id === itemId,
    ) ?? null
  );
}

/** #910: the source for `effect` applied by `combatant`'s own `item` to
 * itself, the way the system's apply-effect chat button builds it: the
 * effect's source merged with an origin context (actor/token/item uuids, the
 * item's origin roll options), the actor itself as target, and only the
 * action traits that are valid effect traits. #914: tagged agent-created
 * for cleanupAgentSelfEffects. Shared by #934's NPC self-effects. */
function agentSelfEffectSource(combatant, item, effect) {
  const actor = combatant.actor;
  const tokenUuid = combatant.token?.uuid ?? null;
  const effectTraits = CONFIG.PF2E?.effectTraits ?? {};
  const traits = (item.system.traits?.value ?? []).filter((t) => t in effectTraits);
  return foundry.utils.mergeObject(effect.toObject(), {
    _id: null,
    flags: { [MODULE_ID]: { agentSelfEffect: true } },
    system: {
      context: {
        origin: {
          actor: actor.uuid,
          token: tokenUuid,
          item: item.uuid,
          spellcasting: null,
          rollOptions: item.getOriginData?.().rollOptions ?? [],
        },
        target: { actor: actor.uuid, token: tokenUuid },
        roll: null,
      },
      traits: { value: traits },
    },
  });
}

/** #910: applies a self-effect action (stance/Rage) the way the installed
 * PF2e system's own chat-card button does (ChatLogPF2e#onClickApplyEffect,
 * a UI handler with no public API): the linked effect's source merged
 * with an origin context (actor/token/item uuids, the item's origin roll
 * options), the actor itself as target, and only the action traits that
 * are valid effect traits. The new effect is created first; only then is
 * a replaced stance removed, the usage card posted and the item's
 * frequency spent (mirroring createUseActionMessage), so a failed creation
 * leaves no side effects. Returns `{ performed, attacks }`. */
async function executeSelfEffectFeat(combatant, candidate) {
  const actor = combatant.actor;
  const item = findFeatItem(actor, candidate.itemId);
  const uuid = item?.system?.selfEffect?.uuid;
  if (!uuid) return { performed: false };
  const effect = await fromUuid(uuid);
  if (typeof effect?.toObject !== "function") return { performed: false };

  try {
    await actor.createEmbeddedDocuments("Item", [agentSelfEffectSource(combatant, item, effect)]);
  } catch (err) {
    console.error(`#910: applying ${item.name}'s effect failed:`, err.message);
    return { performed: false };
  }

  // PF2e RAW: entering a stance ends the one you were in.
  if (
    candidate.replacesStance &&
    (actor.itemTypes?.effect ?? []).some((e) => e.id === candidate.replacesStance)
  ) {
    try {
      await actor.deleteEmbeddedDocuments("Item", [candidate.replacesStance]);
    } catch (err) {
      console.error("#910: removing the previous stance effect failed:", err.message);
    }
  }
  try {
    await item.toMessage?.();
  } catch (err) {
    console.warn(`#910: posting ${item.name}'s usage card failed:`, err.message);
  }
  if (item.system.frequency && item.system.frequency.value > 0) {
    await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
  }
  return { performed: true, attacks: 0, effectName: effect.name ?? item.name };
}

/** #934: an npcSelf effect ability (selfEffectAction / linkedEffectSelf):
 * the linked effect applied to the monster exactly as executeSelfEffectFeat
 * applies a character's (agentSelfEffectSource), created first so a failed
 * creation spends nothing. RAW: entering a stance ends the one you were in. */
async function applyNpcSelfEffect(combatant, item, descriptor) {
  const actor = combatant.actor;
  const effect = await fromUuid(descriptor.params.effectUuid);
  if (typeof effect?.toObject !== "function") return { performed: false };
  const isStance = (item.system?.traits?.value ?? []).includes("stance");
  const previousStance = isStance ? await findActiveStanceEffectId(actor) : null;
  try {
    await actor.createEmbeddedDocuments("Item", [agentSelfEffectSource(combatant, item, effect)]);
  } catch (err) {
    console.error(`#934: applying ${item.name}'s effect failed:`, err.message);
    return { performed: false };
  }
  if (previousStance) {
    try {
      await actor.deleteEmbeddedDocuments("Item", [previousStance]);
    } catch (err) {
      console.error("#934: removing the previous stance effect failed:", err.message);
    }
  }
  return { performed: true, text: `gains ${effect.name ?? item.name}`, tone: "success" };
}

/** #934: an npcSelf heal: rolls the ability's own formula (posted to chat)
 * and applies it as healing through the system's own `applyDamage` with a
 * negative amount -- the confirmed-live shape #132's castHealSpellAndApply
 * uses; the system clamps at maximum HP and applies healing-received
 * modifiers. Reports what was actually regained. */
async function applyNpcSelfHeal(combatant, item, descriptor) {
  const actor = combatant.actor;
  const before = actor.system?.attributes?.hp?.value;
  const max = actor.system?.attributes?.hp?.max;
  let total;
  try {
    const roll = await new Roll(descriptor.params.formula).evaluate();
    total = roll.total;
    try {
      await roll.toMessage?.({
        speaker: typeof ChatMessage?.getSpeaker === "function" ? ChatMessage.getSpeaker({ actor, token: combatant.token }) : undefined,
        flavor: `${item.name}: healing`,
      });
    } catch (err) {
      console.warn(`#934: posting ${item.name}'s healing roll failed:`, err.message);
    }
    await actor.applyDamage({ damage: -total, token: combatant.token });
  } catch (err) {
    console.error(`#934: applying ${item.name}'s healing failed:`, err.message);
    return { performed: false };
  }
  const after = actor.system?.attributes?.hp?.value;
  const healed =
    typeof before === "number" && typeof after === "number" && after !== before
      ? Math.max(0, after - before)
      : Math.max(0, Math.min(total, (typeof max === "number" ? max : Infinity) - (before ?? 0)));
  return { performed: true, healed, text: `heals ${healed} HP`, tone: healed > 0 ? "success" : "neutral" };
}

/** #934: executes an npcSelf candidate. The item is re-read and re-parsed
 * (it may have changed since the vocabulary was built); a stale or spent
 * one returns `{performed: false}` (nothing spent). After the effect/heal
 * succeeds: the usage card is posted, a frequency use spent, the ability's
 * own recharge recorded, and a recharge its text puts on ANOTHER of the
 * creature's abilities (the voidglutton's Feed on Fear -> Consume Light)
 * recorded in the same shared store every NPC category checks. */
export async function executeNpcSelfCandidate(combat, combatant, candidate) {
  const actor = combatant?.actor;
  const item = actorActionItems(actor).find((i) => i.id === candidate.itemId);
  if (!item) return { performed: false };
  const descriptor = parseSelfAbility(item);
  if (!descriptor || descriptor.family !== candidate.family) return { performed: false };
  if (descriptor.frequency && !(descriptor.frequency.value > 0)) return { performed: false };

  const result =
    descriptor.family === "selfHeal"
      ? await applyNpcSelfHeal(combatant, item, descriptor)
      : await applyNpcSelfEffect(combatant, item, descriptor);
  if (!result.performed) return result;

  try {
    await item.toMessage?.();
  } catch (err) {
    console.warn(`#934: posting ${item.name}'s usage card failed:`, err.message);
  }
  if (item.system.frequency && item.system.frequency.value > 0) {
    await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
  }
  await setAbilityRecharge(combat, combatant.id, actionItemSlug(item), descriptor.rechargeFormula);
  const notes = [];
  if (descriptor.crossRecharge) {
    const { name, formula } = descriptor.crossRecharge;
    await setAbilityRecharge(combat, combatant.id, actionItemSlug({ name }), formula);
    notes.push(`${name} recharging (${formula} rounds), per ${item.name}.`);
  }
  if (descriptor.glowRider) notes.push(`If it had Gone Dark, its glow reignites (not automated).`);
  return { ...result, attacks: 0, ...(notes.length ? { gmNote: notes.join("\n") } : {}) };
}

/** #922/#946: a marked-target self-effect (Hunt Prey, Devise a Stratagem,
 * Smite, Duelist's Challenge, Size Up). The linked effect is created the
 * way executeSelfEffectFeat (and the system's own apply-effect button)
 * does, after binding its TokenMark rule to the chosen opponent's token
 * (so TokenMarkRuleElement#preCreate neither reads the user's targets nor
 * opens its interactive prompt) and, for Devise, selecting the `attack`
 * stratagem on its RollOption rule's `selection` (the field the system's
 * own toggle writes). Everything afterwards -- the bonuses/penalties, the
 * d20 replacing the next Strike against the marked creature -- is the
 * system's own rule elements. The vocabulary's target checks (sight,
 * range, non-mindless, the item's Requirements) are re-checked against the
 * live state. The new effect is created first; only then is a prior mark
 * of a re-designating item removed (Hunt Prey/Smite/Size Up: one mark at a
 * time), the usage card posted and frequency spent, so a failed creation
 * leaves no side effects and spends no action. #946: the effect is tagged
 * with the marked token (`markTargetTokenUuid`) so removeMarksTargeting can
 * end it when that creature is defeated or leaves the combat. Returns
 * `{ performed, attacks }`. */
async function executeTargetedSelfEffectFeat(combat, combatant, candidate) {
  const actor = combatant.actor;
  const item = findFeatItem(actor, candidate.itemId);
  const uuid = item?.system?.selfEffect?.uuid;
  if (!uuid) return { performed: false };
  const effect = await fromUuid(uuid);
  if (typeof effect?.toObject !== "function") return { performed: false };
  const config = resolveTargetedSelfEffectConfig(item, effect.toObject());
  if (!config) return { performed: false };
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  const targetTokenUuid = target?.token?.uuid;
  if (!targetTokenUuid) return { performed: false };
  if (config.requiresSight && !hasLineOfSight(combat, combatant.token, target.token)) return { performed: false };
  if (config.rangeFeet != null) {
    const gridSize = combat.scene?.grid?.size ?? 100;
    const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
    if (!(pf2eDistanceFeet(combatant.token, target.token, gridSize, gridDistanceFt) <= config.rangeFeet)) return { performed: false };
  }
  if (config.targetNotMindless && (target.actor?.system?.traits?.value ?? []).includes("mindless")) return { performed: false };
  if (config.needsHearing && actorHasCondition(actor, "deafened")) return { performed: false };
  if (!config.requirements.every((p) => npcSelfRequirementHolds(p, actor, []))) return { performed: false };
  // The system ignores a TokenMark on an actor with no token on the viewed
  // canvas -- the effect would be created unbound.
  if (typeof actor.getActiveTokens !== "function" || actor.getActiveTokens().length === 0) return { performed: false };

  let bound = bindTokenMarkEffect(effect.toObject(), config.markSlug, targetTokenUuid);
  if (bound && config.suboption) {
    bound = selectRollOptionSuboption(bound, config.suboption.option, config.suboption.value);
  }
  if (!bound) {
    console.error(`#922: ${item.name}'s effect has no bindable ${config.markSlug} mark -- not applied.`);
    return { performed: false };
  }

  const priorMarkIds = config.exclusiveMark
    ? (actor.itemTypes?.effect ?? [])
        .filter((e) => (e.system?.rules ?? []).some((r) => r?.key === "TokenMark" && r.slug === config.markSlug))
        .map((e) => e.id)
    : [];
  const tokenUuid = combatant.token?.uuid ?? null;
  const effectTraits = CONFIG.PF2E?.effectTraits ?? {};
  const traits = (item.system.traits?.value ?? []).filter((t) => t in effectTraits);
  let created;
  try {
    const source = foundry.utils.mergeObject(bound, {
      _id: null,
      // #914: agent-created -- an unlimited one (Hunt Prey) is removed at
      // combat end by cleanupAgentSelfEffects. #946: the marked token, for
      // removeMarksTargeting (defeat/removal) and combat-end cleanup.
      flags: { [MODULE_ID]: { agentSelfEffect: true, markTargetTokenUuid: targetTokenUuid } },
      system: {
        context: {
          origin: {
            actor: actor.uuid,
            token: tokenUuid,
            item: item.uuid,
            spellcasting: null,
            rollOptions: item.getOriginData?.().rollOptions ?? [],
          },
          target: { actor: actor.uuid, token: tokenUuid },
          roll: null,
        },
        traits: { value: traits },
      },
    });
    [created] = (await actor.createEmbeddedDocuments("Item", [source])) ?? [];
  } catch (err) {
    console.error(`#922: applying ${item.name}'s effect failed:`, err.message);
    return { performed: false };
  }
  // TokenMarkRuleElement#preCreate drops the item from creation when the
  // uuid doesn't resolve to a token.
  if (!created) return { performed: false };

  const stale = priorMarkIds.filter((id) => id !== created.id);
  if (stale.length) {
    try {
      await actor.deleteEmbeddedDocuments("Item", stale);
    } catch (err) {
      console.error(`#922: removing the previous ${item.name} designation failed:`, err.message);
    }
  }
  try {
    await item.toMessage?.();
  } catch (err) {
    console.warn(`#922: posting ${item.name}'s usage card failed:`, err.message);
  }
  if (item.system.frequency && item.system.frequency.value > 0) {
    await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
  }
  // #925: reported on the AI turn card (which replaced this executor's own
  // GM whisper). The Devise a Stratagem d20 is the GM's to know -- GM-only.
  const d20 = created.system?.badge?.value;
  const text =
    candidate.slug === "hunt-prey"
      ? "hunts its target as prey"
      : candidate.slug === "devise-a-stratagem"
        ? "devises a stratagem against its target"
        : "marks its target";
  const gmNote =
    candidate.slug === "devise-a-stratagem" && typeof d20 === "number" ? `Stratagem d20 = ${d20}` : null;
  return { performed: true, attacks: 0, text, ...(gmNote ? { gmNote } : {}) };
}

/** #914: effects the AI-actor pipeline created (executeSelfEffectFeat's
 * `flags[MODULE_ID].agentSelfEffect` tag) whose own duration is `unlimited`
 * would otherwise outlive the encounter -- removed once, when combat ends.
 * Round/minute/encounter-duration effects are left alone: PF2e's own
 * duration handling expires them, and removing one early would be wrong.
 * #946: an agent-created MARK (tagged `markTargetTokenUuid`) is removed at
 * combat end whatever its duration (Size Up's 1 day): it points at a
 * creature of this fight (#946 spec, mark lifecycle). A failed removal is
 * logged and reported to the GM, never thrown. */
export async function cleanupAgentSelfEffects(combat) {
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant?.actor;
    if (!actor) continue;
    const toRemove = (actor.itemTypes?.effect ?? []).filter(
      (e) =>
        e.flags?.[MODULE_ID]?.agentSelfEffect === true &&
        (e.system?.duration?.unit === "unlimited" || !!e.flags?.[MODULE_ID]?.markTargetTokenUuid),
    );
    if (!toRemove.length) continue;
    try {
      await actor.deleteEmbeddedDocuments("Item", toRemove.map((e) => e.id));
    } catch (err) {
      console.error(`#914: failed to clean up agent self-effects on ${actor.name}:`, err.message);
      try {
        const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
        await whisperGmContent(
          `<p><strong>${esc(actor.name)}:</strong> could not remove ${toRemove.map((e) => esc(e.name)).join(", ")} after combat -- remove manually.</p>`,
        );
      } catch {
        // Reporting is best-effort; cleanup never blocks combat resolution.
      }
    }
  }
}

/** #946: removes every agent-created mark (tagged both `agentSelfEffect`
 * and `markTargetTokenUuid`) bound to `tokenUuid`, on every combatant of
 * `combat` -- the marked creature was defeated or left the combat, which
 * ends the mark by the feats' own text (Duelist's Challenge "until it's
 * defeated, it flees from the encounter, or the encounter ends"). A failed
 * removal is logged and reported to the GM, never thrown; one combatant's
 * failure never blocks another's. */
export async function removeMarksTargeting(combat, tokenUuid) {
  if (!tokenUuid) return;
  for (const combatant of combat?.combatants ?? []) {
    const actor = combatant?.actor;
    if (!actor) continue;
    const toRemove = (actor.itemTypes?.effect ?? []).filter(
      (e) => e.flags?.[MODULE_ID]?.agentSelfEffect === true && e.flags?.[MODULE_ID]?.markTargetTokenUuid === tokenUuid,
    );
    if (!toRemove.length) continue;
    try {
      await actor.deleteEmbeddedDocuments("Item", toRemove.map((e) => e.id));
    } catch (err) {
      console.error(`#946: failed to remove ${actor.name}'s mark on ${tokenUuid}:`, err.message);
      try {
        const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
        await whisperGmContent(
          `<p><strong>${esc(actor.name)}:</strong> could not remove ${toRemove.map((e) => esc(e.name)).join(", ")} from a defeated creature -- remove manually.</p>`,
        );
      } catch {
        // Reporting is best-effort; cleanup never blocks combat resolution.
      }
    }
  }
}

/** #946: hook target for `updateCombatant` (a combatant newly marked
 * defeated) and `deleteCombatant` (it left the combat -- fled or was
 * removed): ends the marks on its token. Active GM only. */
export async function endMarksOnCombatantGone(combatant, changes = null) {
  if (!(game.users?.activeGM?.isSelf ?? game.user?.isGM)) return;
  if (changes && changes.defeated !== true) return;
  const combat = combatant?.parent ?? combatant?.combat ?? null;
  if (!combat || !isModuleCombat(combat)) return;
  await removeMarksTargeting(combat, combatant.token?.uuid ?? null);
}

/** #910: a feat candidate that turned out impossible at execution time
 * (item/effect/target/weapon gone, or effect creation failed) spends no
 * actions; its pick is dropped from this turn's persisted picks so the
 * model can't re-choose it in a loop. */
async function skipUnperformedFeat(combat, combatant, candidate, rationale = null) {
  const turnState = getAgentTurnState(combat, combatant.id);
  const picks = (turnState.maneuverPicks ?? []).filter(
    (p) =>
      !(
        p?.type === candidate.type &&
        p.slug === candidate.slug &&
        (p.targetId || null) === candidate.targetId
      ),
  );
  await setAgentTurnState(combat, combatant.id, { ...turnState, maneuverPicks: picks });
  const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
  // #925: not an action taken, so not on the public turn card -- the GM
  // alone hears about it, with the model's rationale for the attempt.
  await whisperGmContent(
    `<p><strong>${esc(candidate.name ?? candidate.slug)} (${esc(combatant.name)}):</strong> could not be used -- no action spent.</p>` +
      (rationale ? `<p><em>${esc(rationale)}</em></p>` : ""),
  );
  armAgentTimeout(combat, combatant);
  return getPendingAgentTurn(combat);
}

/** #910: Lunge -- "Make a Strike with a melee weapon, increasing your
 * reach by 5 feet for that Strike." The feat's own rule elements (a
 * toggleable `lunge` RollOption in the default "all" domain, plus an
 * ActiveEffectLike adding 5 ft to reach predicated on it) are switched on
 * for exactly this Strike, then off again. Rolled at the turn's current
 * MAP; counts as one attack. */
async function executeLunge(combat, combatant, candidate, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const distance = chebyshevSquares(combatant.token, target.token, gridSize);
  const action = lungeStrikeFor(combatant.actor, distance, gridDistanceFt);
  if (!action) return { performed: false };
  const actionSlug = action.item?.slug ?? action.slug ?? action.label;
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  await combatant.actor.toggleRollOption("all", "lunge", candidate.itemId, true);
  let outcome;
  try {
    outcome = await rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, mapIncrement);
  } finally {
    await combatant.actor.toggleRollOption("all", "lunge", candidate.itemId, false);
  }
  return { performed: true, attacks: 1, strikeOutcomes: [outcome ?? null] };
}

/** #910: Sudden Charge -- "Stride twice. If you end your movement within
 * melee reach of at least one enemy, you can make a melee Strike against
 * that enemy." Two ordinary approach Strides (each stops at melee reach on
 * its own, so a second Stride after the first already arrived is a no-op),
 * then one melee Strike at the turn's current MAP if the target is now in
 * reach of a ready melee strike. Reports the attacks actually made. */
async function executeSuddenCharge(combat, combatant, target) {
  await strideByPosture(combat, combatant, "approach", target);
  if (combatant.isDefeated) return { performed: true, attacks: 0, strikeOutcomes: [] };
  await strideByPosture(combat, combatant, "approach", target);
  if (combatant.isDefeated || target.isDefeated) return { performed: true, attacks: 0, strikeOutcomes: [] };

  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const action = readyMeleeStrikeActions(combatant.actor).find(
    (a) => strikeInReach(combatant, target, a, gridSize, gridDistanceFt).inReach,
  );
  if (!action) return { performed: true, attacks: 0, strikeOutcomes: [] };
  const actionSlug = action.item?.slug ?? action.slug ?? action.label;
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const outcome = await rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, mapIncrement);
  return { performed: true, attacks: 1, strikeOutcomes: [outcome ?? null] };
}

/** #910: Twin Feint -- "Make one Strike with each of your two melee
 * weapons, both against the same target. The target is automatically
 * Off-Guard against the second attack. Apply your multiple attack penalty
 * to the Strikes normally." Neither the feat's rule elements (empty) nor
 * the system automate the Off-Guard, so it is added for the second Strike
 * only and removed right after -- unless the target was already Off-Guard,
 * which is left untouched. The second Strike is skipped if the first one
 * defeated the target. Reports the attacks actually made. */
async function executeTwinFeint(combat, combatant, target) {
  const pair = twinFeintStrikePair(combatant.actor);
  if (!pair) return { performed: false };
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  if (!pair.every((a) => strikeInReach(combatant, target, a, gridSize, gridDistanceFt).inReach)) {
    return { performed: false };
  }
  const [first, second] = pair.map((a) => a.item?.slug ?? a.slug ?? a.label);
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);

  const firstOutcome = await rollAndApplyStrikeAtVariant(combat, combatant, target, first, mapIncrement);
  if (target.isDefeated) return { performed: true, attacks: 1, strikeOutcomes: [firstOutcome ?? null] };

  const addOffGuard = !actorHasCondition(target.actor, "off-guard");
  if (addOffGuard) await target.actor.increaseCondition("off-guard");
  let secondOutcome;
  try {
    secondOutcome = await rollAndApplyStrikeAtVariant(combat, combatant, target, second, mapIncrement + 1);
  } finally {
    if (addOffGuard) await target.actor.decreaseCondition("off-guard", { forceRemove: true });
  }
  return { performed: true, attacks: 2, strikeOutcomes: [firstOutcome ?? null, secondOutcome ?? null] };
}

const TARGETED_ATTACK_TEXT = Object.freeze({
  criticalSuccess: "critical hit",
  success: "hit",
  failure: "miss",
  criticalFailure: "critical miss",
});

function hitPointsOf(actor) {
  const hp = actor?.system?.attributes?.hp;
  return (Number(hp?.value) || 0) + (Number(hp?.temp) || 0);
}

/** #947: spends a used targeted feat's frequency and posts its card (the
 * system's own usage message). */
async function spendTargetedFeatUse(item) {
  try {
    await item.toMessage?.();
  } catch (err) {
    console.warn(`#947: posting ${item.name}'s usage card failed:`, err.message);
  }
  if (item.system?.frequency && item.system.frequency.value > 0) {
    await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
  }
}

/** #947: a `strikePlus` feat -- "Make a [melee] Strike. If you hit and
 * deal damage, the target is <condition> ...". Uses the best ready strike
 * the feat allows (targetedStrikeActionFor), rolled at the turn's current
 * MAP through the ordinary Strike pipeline; counts as one attack. A
 * finisher rolls with the system's own `finisher:<suboption>` toggle on
 * (Precise Strike's finisher dice, the feat's Note), then loses panache --
 * the system doesn't remove it itself. The rider lands only on a hit that
 * really dealt damage (the target's HP + temp HP went down), with the
 * degree's own condition/duration through #915's condition helper, and
 * never on a target immune to the feat (its fear/mental/emotion traits) or
 * to the condition. No usable strike at execution time: nothing spent. */
async function executeTargetedStrikeFeat(combat, combatant, item, descriptor, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  if (!hasLineOfSight(combat, combatant.token, target.token)) return { performed: false };
  const distance = chebyshevSquares(combatant.token, target.token, gridSize);
  const action = targetedStrikeActionFor(combatant.actor, descriptor, distance, gridDistanceFt);
  if (!action) return { performed: false };
  const finisher = (descriptor.traits ?? []).includes("finisher") ? finisherRollOption(item) : null;
  if ((descriptor.traits ?? []).includes("finisher") && !finisher) return { performed: false };

  await spendTargetedFeatUse(item);
  const actor = combatant.actor;
  const actionSlug = action.item?.slug ?? action.slug ?? action.label;
  const { mapIncrement } = getAgentTurnState(combat, combatant.id);
  const hpBefore = hitPointsOf(target.actor);
  let outcome = null;
  if (finisher) await actor.toggleRollOption("all", "finisher", item.id, true, finisher.suboption);
  try {
    outcome = await rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, mapIncrement);
  } finally {
    if (finisher) await actor.toggleRollOption("all", "finisher", item.id, false);
  }
  const gmLines = [];
  if (finisher) {
    // "you lose your panache immediately after performing a finisher"
    const panache = (actor.itemTypes?.effect ?? []).filter((e) => e?.slug === "effect-panache").map((e) => e.id);
    if (panache.length) {
      try {
        await actor.deleteEmbeddedDocuments("Item", panache);
      } catch (err) {
        console.error(`#947: removing panache after ${item.name} failed:`, err.message);
        gmLines.push("Panache could not be removed -- remove it by hand");
      }
    }
  }

  let rider = null;
  if (outcome === "success" || outcome === "criticalSuccess") {
    const degree = descriptor.params.degrees[outcome];
    const dealtDamage = hitPointsOf(target.actor) < hpBefore;
    if (!dealtDamage) {
      rider = "no damage, no effect";
    } else if (target.isDefeated) {
      rider = null;
    } else if (
      target.actor?.isImmuneTo?.(item) === true ||
      degree.conditions.some((c) => target.actor?.isImmuneTo?.(c.slug) === true)
    ) {
      rider = "immune";
    } else {
      try {
        rider = await applyNpcAbilityDegree(combat, combatant, item, target, degree);
      } catch (err) {
        console.error(`#947: ${item.name}'s rider failed:`, err.message);
        rider = "effect FAILED";
        gmLines.push(`${item.name}'s effect could not be applied -- apply by hand`);
      }
    }
  }
  const attackText = TARGETED_ATTACK_TEXT[outcome] ?? "no result";
  return {
    performed: true,
    attacks: 1,
    strikeOutcomes: [outcome ?? null],
    text: rider ? `${attackText}; ${rider}` : attackText,
    tone: outcome === "success" || outcome === "criticalSuccess" ? "success" : outcome ? "failure" : "neutral",
    ...(gmLines.length ? { gmNote: gmLines.join("\n") } : {}),
  };
}

/** #947: the system effect duration for a targetEffect's own duration on
 * the ACTOR (the effect is the actor's): "until the end/start of your next
 * turn" is one round expiring at the actor's turn end/start. */
function targetEffectDuration(durationSeconds) {
  if (durationSeconds === "actorNextTurnEnd") return { value: 1, unit: "rounds", expiry: "turn-end", sustained: false };
  if (durationSeconds === "actorNextTurnStart") return { value: 1, unit: "rounds", expiry: "turn-start", sustained: false };
  return npcPenaltyEffectDuration(durationSeconds);
}

/** #947: a `targetEffect` feat -- Instant Opening: "Choose a target within
 * 30 feet. It's Off-Guard against your attacks until the end of your next
 * turn." Off-Guard against ONE creature's attacks is not the Off-Guard
 * condition (that would expose the target to everyone), so the module
 * builds the system's own per-attacker form, the shape of the system's
 * Effect: Pointed Question: an effect on the ACTOR with a TokenMark bound
 * to the target's token (pre-bound, so TokenMarkRuleElement#preCreate
 * opens no prompt) and an EphemeralEffect of the Off-Guard condition on the
 * actor's attack rolls predicated on the mark; the effect's own
 * duration (on the actor) ends it. It is tagged like #946's marks so
 * removeMarksTargeting/cleanupAgentSelfEffects end it with the target or
 * the combat. The sense trait (visual/auditory) is whichever the target can
 * perceive. Nothing is spent when the target is out of range, can't
 * perceive the distraction, or the effect isn't created. */
async function executeTargetEffectFeat(combat, combatant, item, descriptor, target) {
  const actor = combatant.actor;
  const { params } = descriptor;
  const targetTokenUuid = target.token?.uuid;
  if (!targetTokenUuid) return { performed: false };
  if (typeof actor.getActiveTokens !== "function" || actor.getActiveTokens().length === 0) return { performed: false };
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  if (!(pf2eDistanceFeet(combatant.token, target.token, gridSize, gridDistanceFt) <= params.rangeFeet)) return { performed: false };
  const sense = params.senseChoice ? senseTraitAgainst(target.actor) : null;
  if (params.senseChoice && !sense) return { performed: false };

  const markSlug = item.slug;
  const effectTraits = CONFIG.PF2E?.effectTraits ?? {};
  const traits = [...(item.system.traits?.value ?? []), ...(sense ? [sense] : [])].filter((t) => t in effectTraits);
  const tokenUuid = combatant.token?.uuid ?? null;
  const source = {
    name: `Effect: ${item.name}`,
    type: "effect",
    img: item.img ?? "icons/svg/downgrade.svg",
    system: {
      slug: `effect-${item.slug}`,
      description: { value: `<p>${target.name} is off-guard against ${actor.name}'s attacks (${item.name}).</p>` },
      duration: targetEffectDuration(params.durationSeconds),
      level: { value: actor.level ?? 0 },
      rules: [
        { key: "TokenMark", slug: markSlug, uuid: targetTokenUuid },
        {
          key: "EphemeralEffect",
          affects: "target",
          selectors: ["attack-roll"],
          uuid: params.condition.uuid,
          // The system tests an `affects: "target"` EphemeralEffect against
          // the TARGET's contextual clone, where the origin's mark on it reads
          // `self:mark:<slug>` (CheckContext#cloneActor, pf2e 8.5.0) --
          // `target:mark:` never matches there (confirmed live: a marked
          // creature's AC 16 stayed 16 with it and dropped to 14 with this;
          // an unmarked creature's AC is untouched).
          predicate: [`self:mark:${markSlug}`],
        },
      ],
      tokenIcon: { show: true },
      traits: { value: traits },
      context: {
        origin: { actor: actor.uuid, token: tokenUuid, item: item.uuid, spellcasting: null, rollOptions: [] },
        target: { actor: actor.uuid, token: tokenUuid },
        roll: null,
      },
    },
    flags: {
      [MODULE_ID]: { agentSelfEffect: true, markTargetTokenUuid: targetTokenUuid, targetedActionItemId: item.id },
    },
  };
  let created;
  try {
    [created] = (await actor.createEmbeddedDocuments("Item", [source])) ?? [];
  } catch (err) {
    console.error(`#947: applying ${item.name}'s effect failed:`, err.message);
    return { performed: false };
  }
  if (!created) return { performed: false };
  await spendTargetedFeatUse(item);
  return { performed: true, attacks: 0, text: "off-guard against its attacks", tone: "success" };
}

/** #947: a targeted feat with no selfEffect (feat-action-shapes.mjs).
 * Re-parses the item and re-resolves the target under the detection filter
 * every executor uses; the turn gates were re-checked when
 * applyAgentDecision rebuilt the vocabulary. Returns `{ performed, attacks,
 * ... }` like every feat executor. */
async function executeTargetedActionFeat(combat, combatant, candidate) {
  const item = findFeatItem(combatant.actor, candidate.itemId);
  const descriptor = item ? parseTargetedFeat(item) : null;
  if (!descriptor) return { performed: false };
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return { performed: false };
  if (descriptor.shape === "strikePlus") return executeTargetedStrikeFeat(combat, combatant, item, descriptor, target);
  if (descriptor.shape === "targetEffect") return executeTargetEffectFeat(combat, combatant, item, descriptor, target);
  return { performed: false };
}

/** #910: dispatches a feat candidate to its executor. Every executor
 * returns `{ performed, attacks }` -- `performed: false` means nothing
 * happened and no action is spent. */
async function executeFeatCandidate(combat, combatant, candidate) {
  if (candidate.kind === "selfEffect") return executeSelfEffectFeat(combatant, candidate);
  if (candidate.kind === "targetedSelfEffect") return executeTargetedSelfEffectFeat(combat, combatant, candidate);
  if (candidate.kind === "targetedAction") return executeTargetedActionFeat(combat, combatant, candidate);
  if (candidate.kind !== "composite") return { performed: false };
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return { performed: false };
  if (candidate.slug === "lunge") return executeLunge(combat, combatant, candidate, target);
  if (candidate.slug === "sudden-charge") return executeSuddenCharge(combat, combatant, target);
  if (candidate.slug === "twin-feint") return executeTwinFeint(combat, combatant, target);
  return { performed: false };
}

/** #915: upper bound on one save roll -- a roll that never settles (a
 * dialog that slipped through, a broken hook) must not hang the turn. */
const NPC_ABILITY_SAVE_TIMEOUT_MS = 30000;
const DEGREE_OUTCOMES = ["criticalFailure", "failure", "success", "criticalSuccess"];

/** #915: `target` rolls its save against the NPC ability the way the
 * system's own inline @Check button does (ChatLogPF2e's inline-check
 * handler, read in the installed pf2e.mjs): a numeric DC, the NPC as the
 * roll's `origin`, the ability item, and the ability's traits (plus
 * `item:trait:<t>` for action traits and the @Check's own options) as
 * extra roll options. Check#roll checks `incapacitation` /
 * `item:trait:incapacitation` in those roll options -- its `traits`
 * argument is merged in only after that check -- and then shifts the degree
 * itself against the origin's level, so this never computes a shift. Reads
 * the degree off the returned roll (or the created message). `null` when
 * there is no such save, the roll fails, or it times out. */
async function rollNpcAbilitySave(combatant, target, item, descriptor) {
  const statistic = target.actor?.saves?.[descriptor.save];
  if (!statistic) return null;
  const actionTraits = globalThis.CONFIG?.PF2E?.actionTraits ?? {};
  const extraRollOptions = [
    ...new Set([
      ...descriptor.traits,
      ...descriptor.traits.filter((t) => t in actionTraits).map((t) => `item:trait:${t}`),
      ...descriptor.rollOptions,
    ]),
  ];
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), NPC_ABILITY_SAVE_TIMEOUT_MS);
  });
  try {
    const roll = await Promise.race([
      statistic.roll({
        dc: { value: descriptor.dc },
        origin: combatant.actor,
        item,
        extraRollOptions,
        skipDialog: true,
        createMessage: true,
      }),
      timeout,
    ]);
    if (roll === undefined) return null;
    const degree = roll?.degreeOfSuccess;
    if (typeof degree === "number") return DEGREE_OUTCOMES[degree] ?? null;
    return game.messages?.contents?.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** #915: PF2e never stacks a valued condition -- "you take the higher
 * value" -- whereas actor.increaseCondition(slug, {value}) adds to an
 * existing one. Returns whether anything changed. */
async function applyNpcAbilityCondition(actor, { slug, value }) {
  const existing = actor.getCondition?.(slug) ?? null;
  if (value == null) {
    if (existing) return false;
    await actor.increaseCondition(slug);
    return true;
  }
  const current = existing?.value ?? 0;
  if (existing && current >= value) return false;
  await actor.increaseCondition(slug, { value: existing ? value - current : value });
  return true;
}

/** #915: when a condition "until the end of its next turn" ends: the
 * (round, turn) right after the target's next turn. */
function endOfTargetsNextTurn(combat, targetId) {
  const turns = Array.from(combat.turns ?? combat.combatants ?? []);
  const index = turns.findIndex((c) => c.id === targetId);
  const round = combat.round ?? 0;
  const turn = combat.turn ?? 0;
  if (index < 0) return { round: round + 1, turn };
  const nextRound = index > turn ? round : round + 1;
  return index + 1 >= turns.length
    ? { round: nextRound + 1, turn: 0 }
    : { round: nextRound, turn: index + 1 };
}

/** #935: a numeric duration as the system's effect duration. A duration
 * counts from the NPC's own turn and ends at the start of its turn
 * ("turn-start" expiry with the NPC as the effect's origin), like the
 * system's own bestiary effects. */
function npcPenaltyEffectDuration(durationSeconds) {
  for (const [unit, seconds] of [["days", 86400], ["hours", 3600], ["minutes", 60]]) {
    if (durationSeconds % seconds === 0) return { value: durationSeconds / seconds, unit, expiry: "turn-start", sustained: false };
  }
  return { value: Math.max(1, Math.ceil(durationSeconds / 6)), unit: "rounds", expiry: "turn-start", sustained: false };
}

/** #935: a penalty outcome ("a -1 status penalty to attack rolls for 1
 * minute") as a small effect item on the target, the shape of the system's
 * own bestiary effects (Effect: Hamstring: `type: "effect"`, a
 * `system.duration`, one FlatModifier rule per selector). The item's own
 * duration expires it -- the system's effect handling, not a module sweep
 * (unlike conditions, which carry no duration). The NPC is the effect's
 * origin, so the system counts its duration from the NPC's turn. Throws on
 * a failed creation (the caller reports it). */
async function applyTimedPenalty(combatant, item, target, penalty) {
  const source = {
    name: `${item?.name ?? "NPC ability"} (penalty)`,
    type: "effect",
    img: item?.img ?? "icons/svg/downgrade.svg",
    system: {
      description: { value: `<p>${describeNpcPenalty(penalty)}, from ${item?.name ?? "an NPC ability"}.</p>` },
      duration: npcPenaltyEffectDuration(penalty.durationSeconds),
      level: { value: combatant.actor?.level ?? 0 },
      rules: penalty.selectors.map((selector) => ({
        key: "FlatModifier",
        selector,
        type: penalty.type,
        value: penalty.value,
      })),
      tokenIcon: { show: true },
      traits: { value: [] },
      context: {
        origin: {
          actor: combatant.actor?.uuid ?? null,
          token: combatant.token?.uuid ?? null,
          item: item?.uuid ?? null,
          spellcasting: null,
          rollOptions: [],
        },
        target: { actor: target.actor?.uuid ?? null, token: target.token?.uuid ?? null },
        roll: null,
      },
    },
    flags: { [MODULE_ID]: { npcAbilityPenalty: true } },
  };
  await target.actor.createEmbeddedDocuments("Item", [source]);
}

/** #915: applies one parsed degree to one target and returns a short GM
 * description. A condition with no duration of its own (Frightened) is left
 * to its own decay (Frightened: #943's end-of-turn hook); one with a
 * duration is tracked for removal: rounds
 * count from the NPC's own turn (a duration ends at the start of the
 * creator's turn), and "until the end of its next turn" from the target's. */
async function applyNpcAbilityDegree(combat, combatant, item, target, degree) {
  if (!degree) return "no effect";
  const applied = [];
  for (const condition of degree.none ? [] : degree.conditions) {
    const name = condition.value != null ? `${condition.slug} ${condition.value}` : condition.slug;
    try {
      if (!(await applyNpcAbilityCondition(target.actor, condition))) {
        applied.push(`${name} (already at least that)`);
        continue;
      }
      applied.push(name);
      const duration = condition.durationSeconds;
      if (duration === "actorNextTurnStart" || duration === "actorNextTurnEnd") {
        // #947: a character feat's "until the start/end of YOUR next turn"
        // counts from the acting combatant's own turn.
        await recordNpcAbilityExpiry(combat, {
          targetId: target.id,
          conditionSlug: condition.slug,
          expiry: {
            untilRoundTurn:
              duration === "actorNextTurnStart"
                ? { round: (combat.round ?? 0) + 1, turn: combat.turn ?? 0 }
                : endOfTargetsNextTurn(combat, combatant.id),
          },
          expiresAtWorldTime: null,
          source: item.name,
        });
      } else if (duration === "untilNextTurn") {
        await recordNpcAbilityExpiry(combat, {
          targetId: target.id,
          conditionSlug: condition.slug,
          expiry: { untilRoundTurn: endOfTargetsNextTurn(combat, target.id) },
          expiresAtWorldTime: null,
          source: item.name,
        });
      } else if (typeof duration === "string" && duration.startsWith("while:")) {
        // #933: Gnaw's "Slowed 1 as long as it remains sickened".
        await recordNpcAbilityExpiry(combat, {
          targetId: target.id,
          conditionSlug: condition.slug,
          expiry: { whileCondition: duration.slice("while:".length) },
          expiresAtWorldTime: null,
          source: item.name,
        });
      } else if (typeof duration === "number") {
        await recordNpcAbilityExpiry(combat, {
          targetId: target.id,
          conditionSlug: condition.slug,
          expiry: {
            untilRoundTurn: {
              round: (combat.round ?? 0) + Math.ceil(duration / 6),
              turn: combat.turn ?? 0,
            },
          },
          expiresAtWorldTime: (globalThis.game?.time?.worldTime ?? 0) + duration,
          source: item.name,
        });
      }
    } catch (err) {
      console.error(`${MODULE_ID} | #915: applying ${condition.slug} failed:`, err.message);
      applied.push(`${name} FAILED -- apply by hand`);
    }
  }
  for (const penalty of degree.none ? [] : (degree.penalties ?? [])) {
    const label = describeNpcPenalty(penalty);
    try {
      await applyTimedPenalty(combatant, item, target, penalty);
      applied.push(label);
    } catch (err) {
      console.error(`${MODULE_ID} | #935: applying ${label} failed:`, err?.message);
      applied.push(`${label} FAILED -- apply by hand`);
    }
  }
  if (degree.immuneSeconds) {
    await setNpcAbilityImmunityUntil(
      combat,
      item.id,
      target.id,
      (globalThis.game?.time?.worldTime ?? 0) + degree.immuneSeconds,
    );
    applied.push("temporarily immune");
  }
  return applied.join(", ") || "no effect";
}

/** #915: executes a chosen NPC save ability: re-resolves its targets,
 * spends frequency/recharge (as the system's own use-action card and the
 * breath weapons do), posts the ability card, then rolls each target's save
 * and -- in `auto` mode -- applies that degree ("As <degree>" blocks are
 * already resolved by the parser). `reportOnly` applies nothing; the GM
 * gets each degree's own text instead. A target outside the ability's
 * stated targets ("Any non-boggard") is unaffected (#935). One target's failure never stops the others. Returns
 * `{ performed }`: false (no action spent) only when the item or every
 * target is gone. */
async function executeNpcAbilityCandidate(combat, combatant, candidate) {
  const item = actorActionItems(combatant.actor).find((i) => i.id === candidate.itemId);
  const descriptor = item ? parseSaveAbility(item) : null;
  if (!descriptor) return { performed: false };
  const targets = detectableOpponents(combat, combatant).filter((c) =>
    (candidate.affectedIds ?? []).includes(c.id),
  );
  if (!targets.length) return { performed: false };

  const uses = item.system?.frequency?.value;
  if (typeof uses === "number") {
    await item.update({ "system.frequency.value": Math.max(0, uses - 1) });
  }
  await setAbilityRecharge(combat, combatant.id, actionItemSlug(item), descriptor.rechargeFormula);
  try {
    await item.toMessage?.();
  } catch (err) {
    console.error(`${MODULE_ID} | #915: posting ${item.name} failed:`, err.message);
  }

  // #925: reported on the AI turn card (which replaced this executor's own
  // GM whisper): each target's save and what landed is public; the DC, the
  // "apply by hand" instructions and the rider text are GM-only (gmNote).
  const worldTime = globalThis.game?.time?.worldTime ?? 0;
  const results = [];
  const gmLines = [`${descriptor.save} DC ${descriptor.dc}`];
  for (const target of targets) {
    try {
      if (
        target.actor?.isImmuneTo?.(item) === true ||
        worldTime < getNpcAbilityImmunityUntil(combat, item.id, target.id)
      ) {
        results.push({ targetId: target.id, text: "immune" });
        continue;
      }
      if (npcAbilityExcludesTarget(descriptor, target.actor)) {
        results.push({ targetId: target.id, text: "unaffected" });
        continue;
      }
      const outcome = await rollNpcAbilitySave(combatant, target, item, descriptor);
      if (!outcome) {
        results.push({ targetId: target.id, text: "no save result" });
        gmLines.push(`${target.name}: no save result -- resolve by hand`);
        continue;
      }
      if (descriptor.immuneSeconds) {
        await setNpcAbilityImmunityUntil(combat, item.id, target.id, worldTime + descriptor.immuneSeconds);
      }
      if (descriptor.mode === "auto") {
        const degree = descriptor.degrees[outcome];
        const applied = await applyNpcAbilityDegree(combat, combatant, item, target, degree);
        results.push({ targetId: target.id, outcome, applied });
      } else {
        const text = descriptor.degreeText?.[outcome];
        results.push({ targetId: target.id, outcome });
        gmLines.push(`${target.name}: apply by hand: ${text ?? "see the ability card"}`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | #915: ${item.name} against ${target.name} failed:`, err.message);
      results.push({ targetId: target.id, text: "not resolved" });
      gmLines.push(`${target.name}: failed (${err.message}) -- resolve by hand`);
    }
  }
  if (descriptor.riderText) gmLines.push(`Also applies (by hand): ${descriptor.riderText}`);
  // #935: where an automatic outcome came from, for the GM's review.
  if (descriptor.mode === "auto" && descriptor.family === "inline") gmLines.push("Outcome parsed from the ability's inline text");
  if (descriptor.mode === "auto" && descriptor.family === "override") gmLines.push("Outcome from the reviewed override table");
  return { performed: true, results, gmNote: gmLines.join("\n") };
}

async function whisperGmContent(content) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({ content, whisper: gmIds });
}

/** #925: appends one record to the per-combat AI action log
 * (`flags.pf2e-dungeon-crawl.agentLog` on the Combat document, deleted with
 * it when resolveCombat deletes the combat -- no cleanup code needed).
 * `index` is 0-based per (combatantId, round). Never throws: a failed write
 * is logged and the turn goes on. Returns the stored record, or null. */
export async function appendAgentActionRecord(combat, record) {
  try {
    const current = combat.getFlag(MODULE_ID, "agentLog");
    const log = Array.isArray(current) ? current : [];
    const index = log.filter(
      (r) => r?.combatantId === record.combatantId && r?.round === record.round,
    ).length;
    const stored = { ...record, index };
    await combat.setFlag(MODULE_ID, "agentLog", [...log, stored]);
    return stored;
  } catch (err) {
    console.error(`${MODULE_ID} | #925: appending the AI action record failed:`, err?.message);
    return null;
  }
}

/** #925: creates the consolidated AI turn card on the first logged action of
 * `combatantId` in `round`, and re-renders it in place for every later one --
 * one ChatMessage per (combatant, round), its id kept in
 * `flags.pf2e-dungeon-crawl.agentTurnCards` ({"<combatantId>:<round>": id})
 * on the Combat. A card whose message was deleted is recreated. The card is
 * public unless the first action's record is GM-only (the acting token was
 * hidden from players), in which case it is a GM whisper; a later GM-only
 * row in a public card is itself GM-only (renderAgentTurnCardHtml). Never
 * throws: a failing create/update is logged and the turn goes on. */
export async function renderAgentTurnCard(combat, combatantId, round) {
  try {
    const records = (combat.getFlag(MODULE_ID, "agentLog") ?? []).filter(
      (r) => r?.combatantId === combatantId && r?.round === round,
    );
    if (!records.length) return;
    const content = renderAgentTurnCardHtml({ round, records, combatantId });
    const cards = combat.getFlag(MODULE_ID, "agentTurnCards") ?? {};
    const key = `${combatantId}:${round}`;
    const existing = cards[key] ? game.messages?.get?.(cards[key]) : null;
    if (existing) {
      await existing.update({ content });
      return;
    }
    const combatant = combatantById(combat, combatantId);
    const firstIsGmOnly = [...records].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]?.visibility === "gm";
    const speaker =
      typeof ChatMessage.getSpeaker === "function"
        ? ChatMessage.getSpeaker({ actor: combatant?.actor, token: combatant?.token })
        : undefined;
    const message = await ChatMessage.create({
      content,
      ...(speaker ? { speaker } : {}),
      flags: { [MODULE_ID]: { agentTurnCard: { combatId: combat.id, combatantId, round } } },
      ...(firstIsGmOnly
        ? { whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id) }
        : {}),
    });
    if (message?.id) {
      await combat.setFlag(MODULE_ID, "agentTurnCards", { ...cards, [key]: message.id });
    }
  } catch (err) {
    console.error(`${MODULE_ID} | #925: rendering the AI turn card failed:`, err?.message);
  }
}

/** #925: the name the table sees for combatant `id` -- PF2e's own token
 * name visibility (metagame setting + TokenDocument#playersCanSeeName) is
 * respected so the public card never reveals a name PF2e itself hides. */
function agentDisplayName(combat, id) {
  const c = combatantById(combat, id);
  if (!c) return null;
  const hideNames = game.pf2e?.settings?.tokens?.nameVisibility === true;
  if (hideNames && c.token?.playersCanSeeName === false) return "an unknown creature";
  return c.token?.name ?? c.name ?? null;
}

/** #925: logs the action `combatant` just took and refreshes its turn card.
 * `executionResult` is whatever the candidate's executor returned. */
async function recordAgentAction(combat, combatant, candidate, executionResult, rationale, source = "model") {
  let display;
  try {
    display = describeAgentAction(candidate, executionResult, {
      nameOf: (id) => agentDisplayName(combat, id),
    });
  } catch (err) {
    console.error(`${MODULE_ID} | #925: describing the AI action failed:`, err?.message);
    return;
  }
  const round = combat.round ?? 0;
  const stored = await appendAgentActionRecord(combat, {
    combatantId: combatant.id,
    tokenId: combatant.token?.id ?? combatant.tokenId ?? null,
    round,
    turn: combat.turn ?? 0,
    candidateId: candidate.id ?? null,
    type: candidate.type ?? null,
    kind: candidate.kind ?? null,
    cost: candidate.cost ?? null,
    summary: display.summary,
    target: display.targetId ? { id: display.targetId, name: display.targetName } : null,
    result: display.result,
    gmNote: display.gmNote,
    rationale: rationale || null,
    source,
    visibility: combatant.token?.hidden === true ? "gm" : "all",
  });
  if (stored) await renderAgentTurnCard(combat, combatant.id, round);
}

/**
 * Executes exactly one chosen candidate for `combatantId`'s current turn in
 * `combat`, updates the per-turn state, and advances the turn once actions
 * run out or `endTurn` was chosen. Returns the pending-turn shape for the
 * *next* iteration (same shape getPendingAgentTurn returns), or `null` once
 * the turn has actually ended. The only mutation path an external process
 * ever reaches — see module.mjs's api.applyAgentDecision.
 */
export async function applyAgentDecision(
  combat,
  combatantId,
  candidateId,
  rationale = null,
) {
  const pending = await getPendingAgentTurn(combat);
  if (!pending || pending.combatantId !== combatantId) return null;
  const candidate = pending.candidates.find((c) => c.id === candidateId);
  if (!candidate) return null;

  const combatant = combat.combatant;
  // #925: whatever this candidate's executor returned, for the AI turn card
  // and agentLog (recordAgentAction below). Stays undefined when the
  // branch found nothing to act on (target gone).
  let executionResult;
  // #920: who this action is hostile against, resolved under the same
  // detection filter every executor below uses -- ends any Antagonize floor
  // those combatants hold on this one once the action is really taken.
  let hostileIds = hostileTargetIdsOf(candidate);
  if (hostileIds.length) {
    const detectable = new Set(detectableOpponents(combat, combatant).map((c) => c.id));
    hostileIds = hostileIds.filter((id) => detectable.has(id));
  }
  // #910: what applyCandidateToTurnState charges -- a feat candidate gains
  // the number of Strikes its executor really made (MAP).
  let applied = candidate;
  if (candidate.type === "stride") {
    let target = candidate.targetId
      ? resolveOpponentForTurn(combat, combatant, candidate.targetId)
      : null;
    if (candidate.posture === "reposition") {
      // No real combatant to look up (#103) - a synthetic target whose
      // only job is to give strideByPosture/posturePath an {x, y} to
      // project away from. Re-resolved fresh here rather than trusting
      // stale position data off the candidate, matching every other
      // tier-resolving function in this file's "re-resolve at execution
      // time" convention - the hazard (or the combatant) may have moved
      // between candidate generation and this decision being applied.
      const gridSize = combat.scene?.grid?.size ?? 100;
      const hazard = nearestHazardousRegionPoint(
        combat.scene,
        combatant.token,
        gridSize,
      );
      target = hazard ? { token: { x: hazard.x, y: hazard.y } } : null;
    }
    executionResult = await strideByPosture(combat, combatant, candidate.posture, target);
  } else if (candidate.type === "seek") {
    // #616: matrix/conditions refresh inside performSeek, so the next
    // getPendingAgentTurn (below) rebuilds candidates from the new matrix.
    executionResult = await performSeek(combat, combatant);
  } else if (candidate.type === "strike") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target) {
      const gridSize = combat.scene?.grid?.size ?? 100;
      const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
      const action = (combatant.actor?.system?.actions ?? []).find(
        (a) =>
          a.type === "strike" &&
          (a.item?.slug ?? a.slug ?? a.label) === candidate.actionSlug,
      );
      const check = action
        ? strikeInReach(combatant, target, action, gridSize, gridDistanceFt)
        : null;
      if (check && !check.inReach) {
        hostileIds = [];
        await reportStrikeOutOfReach({
          combat,
          combatant,
          target,
          candidate,
          distance: check.distance,
          reach: check.reach,
        });
        executionResult = { skipped: "target out of reach" };
      } else {
        executionResult = await rollAndApplyStrikeAtVariant(
          combat,
          combatant,
          target,
          candidate.actionSlug,
          candidate.variantIndex,
        );
      }
    }
  } else if (candidate.type === "cast") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      executionResult = await castSpellAndApplySave(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castArea") {
    const targets = detectableOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      executionResult = await castAreaSpellAndApplySaves(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castAttack") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      executionResult = await castAttackSpellAndApplyRoll(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
      );
  } else if (candidate.type === "castDebuff") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      executionResult = await castDebuffSpellAndApplyCondition(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
        candidate.conditionsByOutcome,
      );
  } else if (candidate.type === "breathWeapon") {
    const targets = detectableOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      executionResult = await castBreathWeaponAndApplyDamage(
        combat,
        combatant,
        targets,
        candidate.itemId,
        candidate.damageFormula,
        candidate.damageType,
        candidate.save,
        candidate.dc,
        candidate.rechargeFormula,
      );
  } else if (candidate.type === "multiStrike") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target) {
      // Re-resolved fresh here (not trusted from candidate-build time)
      // since the turn's mapIncrement is this decision's own starting MAP
      // variant for the whole bundle — same "re-resolve at execution time"
      // convention every other tier-resolving branch in this function uses.
      const turnState = getAgentTurnState(combat, combatant.id);
      executionResult = await castMultiStrikeBundleAndApply(
        combat,
        combatant,
        target,
        candidate.strikes,
        turnState.mapIncrement,
      );
    }
  } else if (candidate.type === "castChain") {
    const opponentsById = new Map(
      detectableOpponents(combat, combatant).map((c) => [c.id, c]),
    );
    const orderedTargets = [candidate.targetId, ...candidate.chainedIds]
      .map((id) => opponentsById.get(id))
      .filter(Boolean);
    if (orderedTargets.length)
      executionResult = await castChainSpellAndApplySaves(
        combatant,
        orderedTargets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castHeal") {
    const target = combatantAllies(combat, combatant).find(
      (c) => c.id === candidate.targetId,
    );
    if (target)
      executionResult = await castHealSpellAndApply(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
      );
  } else if (candidate.type === "castBuff") {
    const target = combatantAllies(combat, combatant).find(
      (c) => c.id === candidate.targetId,
    );
    if (target)
      executionResult = await castBuffSpellAndApply(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
      );
  } else if (candidate.type === "castAreaTier") {
    const targets = detectableOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      executionResult = await castTierScalingAreaSpellAndApplySaves(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
        candidate.cost,
      );
  } else if (candidate.type === "castDualHarm") {
    // The harm-direction effect only ever targets opponents (never an
    // ally, per #174's design) at both single-target tiers, so this
    // reuses #118's own castSpellAndApplySave unchanged - confirmed live
    // its damage roll applies correctly through the standard IWR-
    // respecting path regardless of which spell/creature-type combination
    // produced it.
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      executionResult = await castSpellAndApplySave(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castDualHeal") {
    const target = combatantAllies(combat, combatant).find(
      (c) => c.id === candidate.targetId,
    );
    if (target)
      executionResult = await castDualHealAndApply(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.bonus,
      );
  } else if (candidate.type === "castDualArea") {
    // Unlike every other area candidate, this one draws from BOTH pools
    // without allegiance discrimination (#174, per the spell's own RAW
    // text) - harmIds/healIds may each contain a mix of opponent and
    // ally ids.
    const allNearby = [
      ...detectableOpponents(combat, combatant),
      ...combatantAllies(combat, combatant),
    ];
    const harmTargets = allNearby.filter((c) =>
      candidate.harmIds.includes(c.id),
    );
    const healTargets = allNearby.filter((c) =>
      candidate.healIds.includes(c.id),
    );
    if (harmTargets.length || healTargets.length)
      executionResult = await castDualAreaAndApply(
        combatant,
        harmTargets,
        healTargets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castTargetCount") {
    // Pre-selected targets are drawn from a single pool at candidate-build
    // time (allies for a healing-trait spell, opponents otherwise), but
    // dispatch doesn't need to know which - searching both is cheap and
    // correct regardless.
    const allNearby = [
      ...detectableOpponents(combat, combatant),
      ...combatantAllies(combat, combatant),
    ];
    const targets = allNearby.filter((c) => candidate.targetIds.includes(c.id));
    if (targets.length)
      executionResult = await castTargetCountSpellAndApply(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castAutoHitAreaTier") {
    const targets = detectableOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      executionResult = await castAutoHitAreaSpellAndApplyDamage(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
        candidate.cost,
      );
  } else if (candidate.type === "maneuver") {
    executionResult = await executeManeuverCandidate(combat, combatant, candidate);
  } else if (candidate.type === "feat") {
    const result = await executeFeatCandidate(combat, combatant, candidate);
    if (!result.performed) return skipUnperformedFeat(combat, combatant, candidate, rationale);
    applied = { ...candidate, attacks: result.attacks ?? 0 };
    executionResult = result;
  } else if (candidate.type === "npcAbility") {
    const result = await executeNpcAbilityCandidate(combat, combatant, candidate);
    if (!result.performed) return skipUnperformedFeat(combat, combatant, candidate, rationale);
    executionResult = result;
  } else if (candidate.type === "npcMove") {
    const result = await executeNpcMoveCandidate(combat, combatant, candidate);
    if (!result.performed) return skipUnperformedFeat(combat, combatant, candidate, rationale);
    // #932: its Strike (if one was made) counts toward MAP, and only a
    // Strike makes the ability hostile (#920).
    applied = { ...candidate, attacks: result.attacks ?? 0 };
    if (!result.attacks) hostileIds = [];
    executionResult = result;
  } else if (candidate.type === "npcSelf") {
    // #934: a self-buff or self-heal -- not hostile, no attack.
    const result = await executeNpcSelfCandidate(combat, combatant, candidate);
    if (!result.performed) return skipUnperformedFeat(combat, combatant, candidate, rationale);
    executionResult = result;
  } else if (candidate.type === "npcStrike") {
    const result = await executeNpcStrikeCandidate(combat, combatant, candidate);
    // Not legal any more (a stale grab, a target out of reach, a spent net):
    // nothing spent, the pick dropped.
    if (!result.performed) return skipUnperformedFeat(combat, combatant, candidate, rationale);
    // #933: each shape's own MAP rule ("counts as two attacks"; Constrict
    // and Rend are no attacks).
    applied = { ...candidate, attacks: result.attacks ?? 0 };
    executionResult = result;
  }

  // #933: the turn's Strikes, for Rend's "two consecutive Strikes".
  await appendTurnStrikeLog(combat, combatant.id, strikeRecordsOf(candidate, executionResult));

  // #925: one row on this combatant's consolidated turn card (replacing the
  // old per-decision GM whisper and stalled-move whisper). Never throws.
  await recordAgentAction(combat, combatant, candidate, executionResult, rationale);

  if (hostileIds.length) await clearAntagonizeOnHostileAction(combat, combatant, hostileIds);

  const turnState = getAgentTurnState(combat, combatantId);
  const nextTurnState = applyCandidateToTurnState(turnState, applied);
  await setAgentTurnState(combat, combatantId, nextTurnState);

  if (nextTurnState.actionsRemaining <= 0) {
    if (game.combats.has(combat.id) && combat.combatant?.id === combatantId)
      await combat.nextTurn();
    return null;
  }
  // Actions remain — re-arm the timeout for the next decision rather than
  // leaving this turn permanently unwatched after one action.
  armAgentTimeout(combat, combatant);
  return getPendingAgentTurn(combat);
}
