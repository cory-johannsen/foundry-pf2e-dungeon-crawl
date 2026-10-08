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
import { makeFoundryApi } from "./foundry-api.mjs";
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
} from "./agent-candidates.mjs";
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
} from "./dungeon-strike-riders.mjs";
import {
  drawAndApplyCriticalCard,
  hitDeckCategory,
  fumbleDeckCategory,
} from "./dungeon-critical-deck.mjs";
import { fetchCombatDecision } from "./agent-service-client.mjs";
import { withDialogsSuppressed } from "./trap-combat.mjs";
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
    getPending = getPendingAgentTurn,
    applyDecision = applyAgentDecision,
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
  // #551: footprint-aware -- nearest-cell distance between the two tokens'
  // rectangles (width/height in cells, default 1). For two 1x1 tokens this
  // equals the old |top-left delta| / gridSize exactly.
  const axis = (aPos, aSize, bPos, bSize) => {
    const aMin = aPos / gridSize;
    const bMin = bPos / gridSize;
    const aMax = aMin + ((aSize ?? 1) - 1);
    const bMax = bMin + ((bSize ?? 1) - 1);
    return Math.max(aMin - bMax, bMin - aMax);
  };
  const dx = axis(a.x, a.width, b.x, b.width);
  const dy = axis(a.y, a.height, b.y, b.height);
  return Math.max(dx, dy, 0);
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
function getReactionUsed(combat, combatantId, round) {
  const stored = combat.getFlag(MODULE_ID, "reactionUsed") ?? {};
  return stored[combatantId] === round;
}

/** Records that `combatantId` has spent their reaction for `round`. */
async function markReactionUsed(combat, combatantId, round) {
  const stored = combat.getFlag(MODULE_ID, "reactionUsed") ?? {};
  await combat.setFlag(MODULE_ID, "reactionUsed", {
    ...stored,
    [combatantId]: round,
  });
}

/** Announces a #202 Reactive Strike publicly (a visible battlefield event
 * every player at the table would want to see, unlike
 * `postAgentDecisionChat`'s GM-only decision rationale). */
async function postReactiveStrikeChat(reactor, attacker) {
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const content = game.i18n.format("PF2EDC.Dungeon.Combat.ReactiveStrikeChat", {
    name: esc(reactor.name),
    target: esc(attacker.name),
  });
  await ChatMessage.create({ content });
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

    const readyActions = (reactor.actor?.system?.actions ?? [])
      .filter(
        (a) => a.type === "strike" && a.ready !== false && !a.item?.isRanged,
      )
      .map((a) => ({
        slug: a.item?.slug ?? a.slug ?? a.label,
        label: a.label,
        reachSquares: actionReachSquares(a, gridDistanceFt),
      }));
    const distanceSquares = chebyshevSquares(
      reactor.token,
      mover.token,
      gridSize,
    );
    const inReachActions = readyActions.filter(
      (a) => distanceSquares <= a.reachSquares,
    );
    if (!inReachActions.length) continue;
    const restriction = parseReactiveStrikeWeaponRestriction(item.name);
    const matched = restriction
      ? matchMultiStrikeActionSlug(restriction, inReachActions)
      : inReachActions[0];
    if (!matched) continue;

    opportunities.push({ reactor, actionSlug: matched.slug });
  }
  return opportunities;
}

/**
 * Executes every current Reactive Strike opportunity against `mover` — the
 * single entry point every trigger (ranged-attack chat message,
 * agent-controlled Stride, GM manual check) calls into, so reaction
 * economy, weapon restrictions, and the chat announcement stay identical
 * regardless of what provoked the reaction.
 */
export async function offerReactiveStrikesAgainst(combat, mover) {
  if (!isModuleCombat(combat)) return;
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const opportunities = findReactiveStrikeOpportunities(
    combat,
    mover,
    gridSize,
    gridDistanceFt,
  );
  for (const { reactor, actionSlug } of opportunities) {
    await markReactionUsed(combat, reactor.id, combat.round);
    await rollAndApplyStrikeAtVariant(combat, reactor, mover, actionSlug, 0);
    await postReactiveStrikeChat(reactor, mover);
  }
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

  await offerReactiveStrikesAgainst(combat, attacker);
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

  await target.actor.applyDamage({
    damage: damageRoll,
    token: target.token,
    outcome: context.outcome,
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
      await drawCriticalCardForStrike(
        context.outcome,
        strike,
        soundContext,
        attacker,
        target,
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
      const affected = shape
        ? rawOpponents
            .filter((o) => {
              const center = tokenCenter(o.token, gridSize);
              return shape.contains(center.x - origin.x, center.y - origin.y);
            })
            .map((o) => ({ id: o.id, name: o.name }))
        : [];
      return { centerType: "opponent", centerId: rawOpponents[i].id, affected };
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

/** Reads back Combat's own per-turn agent bookkeeping, or a fresh one
 * (`initAgentTurnState()`) if this is the first decision seen for this exact
 * combatant/round/turn — see `currentStoredAgentTurnState` above. */
function getAgentTurnState(combat, combatantId) {
  const stored = currentStoredAgentTurnState(combat, combatantId);
  return stored
    ? {
        actionsRemaining: stored.actionsRemaining,
        mapIncrement: stored.mapIncrement,
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
  await walkTokenThroughSteps(me, waypoint.steps, gridSize);
  if (!preReported)
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
  await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
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
 */
async function drawCriticalCardForStrike(
  outcome,
  strike,
  soundContext,
  combatant,
  target,
) {
  if (outcome === "criticalSuccess") {
    return drawHitCardMultiplier(hitDeckCategory(soundContext.damageType), {
      combatant,
      target,
      damageType: soundContext.damageType,
    });
  } else if (outcome === "criticalFailure") {
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
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      const soundContext = strikeSoundContext(strike, target);
      playStrikeSound(outcome, soundContext);
      await postStrikeRiderReminder(combatant, strike, outcome);
      await resolveGrabRider(combatant, target, strike, outcome);
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
          await target.actor.applyDamage({
            damage: damageRoll,
            token: target.token,
            outcome,
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
  const opponents = rawOpponents.map((c) => ({
    id: c.id,
    name: c.name,
    distanceSquares: chebyshevSquares(combatant.token, c.token, gridSize),
    hp: c.actor?.system?.attributes?.hp?.value ?? null,
    hasLineOfSight: canSee(c),
  }));
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
  };
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

  const me = combatant.token;
  const dest = target.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const targetCell = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(
    combat,
    combatant,
    posture === "approach" ? targetCell : null,
  );
  const path = posturePath(
    start,
    targetCell,
    posture,
    speedSquares,
    isBlocked,
    bounds,
    moverFootprint,
  );
  if (!path) return "no-route";

  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const stopWithin = posture === "approach" ? MELEE_REACH_SQUARES : 0;
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
  if (!waypoint) return "blocked";
  await walkTokenThroughSteps(me, waypoint.steps, gridSize);
  if (!preReported)
  await reportMoveOverlap({
    combat,
    combatant,
    kind: "strideByPosture",
    posture,
    targetCombatant: target,
    startCell: start,
    goalCell: targetCell,
    path,
    steps: waypoint.steps,
    occupantsSnapshot: occupants,
    speedSquares,
    stopWithin,
    gridSize,
  });
  await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
}

/** Rolls one strike at a specific MAP `variantIndex` against `target` and
 * applies damage on a hit — the same dialog-suppression/roll/damage/
 * applyDamage sequence rollAndApplyStrike already uses, generalized to a
 * caller-chosen variant instead of always variants[0]. */
async function rollAndApplyStrikeAtVariant(
  combat,
  combatant,
  target,
  actionSlug,
  variantIndex,
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
      await variant.roll({ target: targetRef, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      const soundContext = strikeSoundContext(strike, target);
      playStrikeSound(outcome, soundContext);
      await postStrikeRiderReminder(combatant, strike, outcome);
      await resolveGrabRider(combatant, target, strike, outcome);
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
          await target.actor.applyDamage({
            damage: damageRoll,
            token: target.token,
            outcome,
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
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    playAttackSpellSound(outcome);
    let damageMultiplier = null;
    if (outcome === "criticalSuccess") {
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
    } else if (outcome === "criticalFailure") {
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
        // crit occurred (set only in the `criticalSuccess` branch above),
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

/**
 * Whispers the GM a chat card naming which combatant the external agent
 * loop just chose an action for, and what it chose — the only place a GM
 * watching the table sees an agent's decision at all otherwise (#147:
 * before this, it only ever reached `tools/agent-loop/poll.mjs`'s own
 * terminal, which most tables don't have visible during play). `rationale`
 * is optional and provider-dependent (Claude supplies one, Laya never does
 * — see `tools/agent-loop/README.md`), so it's an extra line only when
 * present rather than a placeholder implying every provider explains itself.
 * Escaped the same way every other LLM/user-supplied string reaching a chat
 * card in this module is (`choice-prompts.mjs`, `gm-resolution.mjs`), since
 * `rationale` is free text from an external model response, not authored
 * content this module controls.
 */
async function postAgentDecisionChat(combatant, candidate, rationale) {
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  let content = game.i18n.format("PF2EDC.Dungeon.Combat.AgentDecisionChat", {
    name: esc(combatant.name),
    summary: esc(candidate.summary ?? candidate.type),
  });
  if (rationale) content += `<p><em>${esc(rationale)}</em></p>`;
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({ content, whisper: gmIds });
}

/** Whispers the GM a follow-up chat card when an agent-controlled
 * combatant's chosen stride resolved to "blocked" (#140) -- a route
 * exists but every landing cell within reach was occupied, distinct from
 * a normal silent move or a genuinely unreachable target ("no-route",
 * not flagged here since that's the ordinary "nothing to do" case the
 * pre-move announcement's own summary already covers). Purely a
 * visibility improvement; no retry or behavior change. */
async function postMoveStalledChat(combatant, status) {
  if (status !== "blocked") return;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const content = game.i18n.format(
    "PF2EDC.Dungeon.Combat.AgentMoveStalled",
    { name: esc(combatant.name) },
  );
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({ content, whisper: gmIds });
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
  await postAgentDecisionChat(combatant, candidate, rationale);
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
    const status = await strideByPosture(combat, combatant, candidate.posture, target);
    await postMoveStalledChat(combatant, status);
  } else if (candidate.type === "seek") {
    // #616: matrix/conditions refresh inside performSeek, so the next
    // getPendingAgentTurn (below) rebuilds candidates from the new matrix.
    await performSeek(combat, combatant);
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
        await reportStrikeOutOfReach({
          combat,
          combatant,
          target,
          candidate,
          distance: check.distance,
          reach: check.reach,
        });
      } else {
        await rollAndApplyStrikeAtVariant(
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
      await castSpellAndApplySave(
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
      await castAreaSpellAndApplySaves(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castAttack") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      await castAttackSpellAndApplyRoll(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
      );
  } else if (candidate.type === "castDebuff") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      await castDebuffSpellAndApplyCondition(
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
      await castBreathWeaponAndApplyDamage(
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
      await castMultiStrikeBundleAndApply(
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
      await castChainSpellAndApplySaves(
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
      await castHealSpellAndApply(
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
      await castBuffSpellAndApply(
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
      await castTierScalingAreaSpellAndApplySaves(
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
      await castSpellAndApplySave(
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
      await castDualHealAndApply(
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
      await castDualAreaAndApply(
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
      await castTargetCountSpellAndApply(
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
      await castAutoHitAreaSpellAndApplyDamage(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
        candidate.cost,
      );
  }

  const turnState = getAgentTurnState(combat, combatantId);
  const nextTurnState = applyCandidateToTurnState(turnState, candidate);
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
