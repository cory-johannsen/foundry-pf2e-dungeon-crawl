/**
 * #1278: a human player's Defensive Advance (Champion flourish, 2 actions:
 * "You Raise your Shield and Stride. If you end your movement within melee
 * reach of at least one enemy, you can make a melee Strike against that
 * enemy").
 *
 * The PF2E Automated Action Tracker (pf2e-auto-action-tracker) models the
 * feat as one 2-action activity but only absorbs its parts at no extra cost
 * in the order Raise a Shield -> Stride -> Strike, and players Stride first,
 * which breaks the activity and charges every later action again. This
 * module (1) raises the shield the moment the feat card appears and (2)
 * Strikes the targeted enemy when the first completed movement ends in melee
 * reach, both on the acting player's own client, through the normal PF2e
 * pipeline, so the tracker, handleManualStrikeDamage and the reaction hooks
 * treat the Strike exactly like a manual one.
 */
import {
  isModuleCombat, isMeleeStrikeAction, chebyshevSquares, actionReachSquares,
} from "./dungeon-combat.mjs";
import { areHostile } from "./force-hostility.mjs";
import {
  TRACKER_NAMESPACE, isDefensiveAdvanceMessage, createPendingStore, armPending,
  peekPending, consumePending, resolveTargetToken, validateTarget, pickMeleeStrike,
  mapVariantIndex, clearPendingWhere, logHasMessage, activityHasMoveChild, degreeToOutcome,
} from "./defensive-advance-logic.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const LANG = "PF2EDC.Dungeon.Combat.DefensiveAdvance";
const TAG = `${MODULE_ID} | #1278:`;

/** Client-local pending Strikes, keyed by token id (see armPending). */
export const pendingDefensiveAdvance = createPendingStore();

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultDeps() {
  return {
    game: globalThis.game,
    log: console,
    notify: (key) => globalThis.ui?.notifications?.warn(globalThis.game.i18n.localize(key)),
    raiseAShield: (args) => globalThis.game.pf2e.actions.raiseAShield(args),
    sleepFn: defaultSleep,
    isModuleCombat,
    isMeleeStrikeAction,
    chebyshevSquares,
    actionReachSquares,
    areHostile,
    withDialogsSuppressed: (g, fn) => withDialogsSuppressed(g, fn),
  };
}

const trackerLogOf = (combatant) => combatant?.flags?.[TRACKER_NAMESPACE]?.log;

/**
 * Poll the combatant's tracker log until `predicate(log)` holds, up to
 * `attempts` sleeps. The tracker records actions through an async GM socket
 * call, so an action we trigger can be evaluated before the entry it depends
 * on exists. Resolves false on timeout (callers proceed anyway).
 */
export async function waitForTrackerLog(combatant, predicate, { attempts = 20, intervalMs = 100, sleepFn = defaultSleep } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (predicate(trackerLogOf(combatant) ?? [])) return true;
    await sleepFn(intervalMs);
  }
  return predicate(trackerLogOf(combatant) ?? []);
}

/**
 * createChatMessage: the author's own client reacts to their Defensive
 * Advance feat card. Raises the shield (never lowering a raised one) and
 * arms the pending Strike. Never throws.
 */
export async function onDefensiveAdviceCard(message, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  try {
    if (!isDefensiveAdvanceMessage(message)) return;
    if (message.author?.id !== d.game.user?.id) return;
    const sceneId = message.speaker?.scene;
    const combat = d.game.combats?.contents?.find(
      (c) => c.scene?.id === sceneId && d.isModuleCombat(c) && (c.started ?? c.round > 0),
    );
    if (!combat) return;
    const mover = combat.combatants.find((c) => c.tokenId === message.speaker?.token);
    if (!mover || mover.isDefeated) return;
    if (mover.getFlag(MODULE_ID, "agentControlled")) return;
    if (combat.combatant?.id !== mover.id) return;

    await waitForTrackerLog(mover, (log) => logHasMessage(log, message.id), { sleepFn: d.sleepFn });

    armPending(pendingDefensiveAdvance, {
      tokenId: mover.tokenId, combatId: combat.id, combatantId: mover.id,
      round: combat.round, featMessageId: message.id,
    });

    const shield = mover.actor?.heldShield;
    if (!shield) return d.notify(`${LANG}.NoShield`);
    // raiseAShield is a toggle: with the effect present it LOWERS the shield.
    if (shield.isRaised) return d.notify(`${LANG}.ShieldAlreadyRaised`);
    await d.raiseAShield({ actors: [mover.actor] });
  } catch (err) {
    d.log.error?.(`${TAG} Defensive Advance feat handler failed:`, err?.message ?? err);
  }
}

/**
 * Runs `fn` with this user's PF2e check/damage roll dialogs off, restoring
 * the previous values afterwards (the same per-user flag toggle
 * rollAndApplyStrike uses; a player may update their own user flags).
 */
export async function withDialogsSuppressed(game, fn) {
  const settings = game.user.flags?.pf2e?.settings ?? {};
  const prevCheck = settings.showCheckDialogs;
  const prevDamage = settings.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    return await fn();
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevCheck,
      "flags.pf2e.settings.showDamageDialogs": prevDamage,
    });
  }
}

/**
 * moveToken: the first completed movement of a token with a pending
 * Defensive Advance ends the Stride. If the one targeted enemy is then in
 * melee reach, roll a melee Strike at it exactly as the player would
 * (attack, then damage on a hit); handleManualStrikeDamage applies the
 * damage. `hookArgs` are the moveToken arguments after (tokenDoc, movement);
 * if one is a User other than the local user, the move is not ours and the
 * pending state is left alone. Never throws.
 */
export async function onDefensiveAdviceMove(tokenDoc, movement, deps = {}, hookArgs = []) {
  const d = { ...defaultDeps(), ...deps };
  try {
    if (!peekPending(pendingDefensiveAdvance, tokenDoc?.id)) return;
    const actingUser = hookArgs.find((a) => a && typeof a === "object" && "isGM" in a);
    if (actingUser && actingUser.id !== d.game.user?.id) return;
    if (!["dragging", "keyboard"].includes(movement?.method)) return;
    const waypoints = movement.passed?.waypoints ?? [];
    if (!waypoints.length) return;
    if (waypoints.some((w) => w?.action === "displace" || w?.action === "blink")) return;

    const pending = consumePending(pendingDefensiveAdvance, tokenDoc.id);
    const combat = d.game.combats?.get(pending.combatId);
    if (!combat || combat.round !== pending.round || combat.combatant?.id !== pending.combatantId) return;
    const mover = combat.combatants.get(pending.combatantId);
    if (!mover || mover.isDefeated) return;

    const targeted = resolveTargetToken(d.game.user?.targets);
    if (!targeted.ok) return d.notify(`${LANG}.TargetOne`);
    const targetDoc = targeted.token.document ?? targeted.token;
    const target = combat.combatants.find((c) => c.tokenId === targetDoc.id);
    const verdict = validateTarget({
      targetCombatant: target,
      moverCombatant: mover,
      hostile: !!target && d.areHostile(combat, mover, target),
    });
    if (!verdict.ok) return d.notify(`${LANG}.TargetInvalid`);

    const gridSize = combat.scene?.grid?.size ?? 100;
    const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
    const distance = d.chebyshevSquares(tokenDoc, target.token, gridSize);
    const strike = pickMeleeStrike(mover.actor?.system?.actions, distance, {
      reachOf: (a) => d.actionReachSquares(a, gridDistanceFt),
      isMelee: d.isMeleeStrikeAction,
    });
    if (!strike) return; // out of reach is normal after a short Stride; the Strike is optional

    // The tracker logs the Stride through an async GM socket call; let it land
    // first so the Strike is absorbed as the activity's third child.
    await waitForTrackerLog(mover, (log) => activityHasMoveChild(log, pending.featMessageId), { sleepFn: d.sleepFn });

    const log = trackerLogOf(mover);
    let variantIndex = 0;
    if (Array.isArray(log)) variantIndex = mapVariantIndex(log);
    else d.notify(`${LANG}.MapUnknown`);
    const variant = strike.variants[Math.min(variantIndex, strike.variants.length - 1)];

    const targetRef = { document: target.token };
    await d.withDialogsSuppressed(d.game, async () => {
      const roll = await variant.roll({ target: targetRef, createMessage: true, skipDialog: true });
      const outcome = degreeToOutcome(roll?.degreeOfSuccess ?? roll?.options?.degreeOfSuccess);
      if (outcome) await strike.damage({ target: targetRef, outcome, createMessage: true });
    });
  } catch (err) {
    d.log.error?.(`${TAG} Defensive Advance Strike failed:`, err?.message ?? err);
  }
}

/** Drop every pending Strike belonging to `combat` (turn over / combat gone). */
export function clearDefensiveAdvanceForCombat(combat) {
  return clearPendingWhere(pendingDefensiveAdvance, (e) => e.combatId === combat?.id);
}

/** updateCombat: any turn or round change ends an unspent Defensive Advance. */
export function onDefensiveAdviceCombatUpdate(combat, changes) {
  if (!changes || !("turn" in changes || "round" in changes)) return 0;
  return clearDefensiveAdvanceForCombat(combat);
}

/** Registers the four hooks. Wrapped so Foundry's extra hook arguments never become `deps`. */
export function registerDefensiveAdvanceHooks(hooks = globalThis.Hooks) {
  hooks.on("createChatMessage", (message) => onDefensiveAdviceCard(message));
  hooks.on("moveToken", (tokenDoc, movement, ...rest) => onDefensiveAdviceMove(tokenDoc, movement, {}, rest));
  hooks.on("updateCombat", (combat, changes) => onDefensiveAdviceCombatUpdate(combat, changes));
  hooks.on("deleteCombat", (combat) => clearDefensiveAdvanceForCombat(combat));
}
