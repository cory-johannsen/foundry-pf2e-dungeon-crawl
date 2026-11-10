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
  logHasMessage,
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
