/**
 * #1281: a human player's Vicious Swing (Fighter flourish, 2 actions: "Make
 * a melee Strike. This counts as two attacks when calculating your multiple
 * attack penalty. If this Strike hits, you deal an extra die of weapon
 * damage" -- two dice at level 10+, three at 18+).
 *
 * The PF2E Automated Action Tracker has no library entry for the feat: it
 * charges the card 2 actions and any Strike after it 1 more. On the acting
 * player's own client this module (1) rolls the melee Strike through the
 * normal PF2e pipeline at the right MAP, (2) adds the extra weapon dice to
 * that Strike's own damage roll via a short-lived Effect whose DamageDice
 * rule element is gated on a roll option (strike.damage() takes extra roll
 * options but no dice), and (3) corrects the tracker log through the
 * tracker's own GM-side `editAction` socket call: Strike cost 0 and the card
 * marked MAP-relevant, so the log shows 2 actions and 2 attacks.
 * handleManualStrikeDamage applies the damage exactly as for a manual Strike.
 */
import {
  isModuleCombat, isMeleeStrikeAction, chebyshevSquares, actionReachSquares,
} from "./dungeon-combat.mjs";
import { areHostile } from "./force-hostility.mjs";
import {
  TRACKER_NAMESPACE, resolveTargetToken, validateTarget, pickMeleeStrike, mapVariantIndex,
  logHasMessage, degreeToOutcome,
} from "./defensive-advance-logic.mjs";
import { waitForTrackerLog, withDialogsSuppressed } from "./defensive-advance.mjs";
import {
  EXTRA_DICE_OPTION, isViciousSwingMessage, extraDiceCount, weaponDieSize,
  buildExtraDiceEffectData, costFixUpdates, findStrikeMessageId, sweepableEffectIds,
} from "./vicious-swing-logic.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const LANG = "PF2EDC.Dungeon.Combat.ViciousSwing";
const TAG = `${MODULE_ID} | #1281:`;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const trackerLogOf = (combatant) => combatant?.flags?.[TRACKER_NAMESPACE]?.log;
const REASON_KEYS = {
  none: "TargetNone", many: "TargetMany", "not-hostile": "TargetNotHostile",
  defeated: "TargetDefeated", "not-in-combat": "TargetNotInCombat", self: "TargetSelf",
};

export function defaultDeps() {
  const g = globalThis;
  return {
    game: g.game,
    log: console,
    notify: (key) => g.ui?.notifications?.warn(g.game.i18n.localize(`${LANG}.${key}`)),
    whisperGM: (content) => g.ChatMessage?.create({
      content, whisper: g.ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    }),
    sleepFn: defaultSleep,
    now: () => Date.now(),
    isModuleCombat,
    isMeleeStrikeAction,
    chebyshevSquares,
    actionReachSquares,
    areHostile,
    withDialogsSuppressed: (game, fn) => withDialogsSuppressed(game, fn),
    getTrackerSocket: () => g.socketlib?.modules?.get(TRACKER_NAMESPACE),
  };
}

/** Poll until every message id appears in the combatant's tracker log. */
export function waitForLogEntries(combatant, msgIds, { attempts = 20, intervalMs = 100, sleepFn = defaultSleep } = {}) {
  return waitForTrackerLog(
    combatant, (log) => msgIds.every((id) => logHasMessage(log, id)), { attempts, intervalMs, sleepFn },
  );
}

/**
 * Make the swing cost 2 actions: wait for both entries, then edit the card
 * (MAP-relevant) and the Strike (cost 0) through the tracker's GM socket.
 * On any failure, tell the player and whisper the GM to refund by hand.
 */
export async function fixTrackerCost({ combatant, cardMsgId, strikeMsgId }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  const fail = (why) => {
    d.log.warn?.(`${TAG} tracker cost fix skipped: ${why}`);
    d.notify("FixFailed");
    try {
      d.whisperGM?.(`Vicious Swing: refund 1 action for ${combatant?.name ?? combatant?.actor?.name ?? "the actor"} by hand.`);
    } catch { /* best effort */ }
    return false;
  };
  try {
    if (!strikeMsgId) return fail("no Strike message found");
    const socket = d.getTrackerSocket();
    if (!socket) return fail("tracker socket unavailable");
    const landed = await waitForLogEntries(combatant, [cardMsgId, strikeMsgId], { sleepFn: d.sleepFn });
    if (!landed) return fail("tracker log entries never appeared");
    const updates = costFixUpdates();
    await socket.executeAsGM("editAction", { combatantId: combatant.id, msgId: cardMsgId, updates: updates.card });
    await socket.executeAsGM("editAction", { combatantId: combatant.id, msgId: strikeMsgId, updates: updates.strike });
    return true;
  } catch (err) {
    return fail(err?.message ?? err);
  }
}

/** Delete every stale extra-dice Effect on the actor. Never throws. */
export async function sweepExtraDiceEffects(actor) {
  try {
    const ids = sweepableEffectIds(actor?.items);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  } catch (err) {
    console.warn(`${TAG} could not sweep extra-dice effects:`, err?.message ?? err);
  }
}

/**
 * createChatMessage: the author's own client reacts to their Vicious Swing
 * feat card. Never throws.
 */
export async function onViciousSwingCard(message, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  try {
    if (!isViciousSwingMessage(message)) return;
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
    const actor = mover.actor;
    if (!actor) return;

    const targeted = resolveTargetToken(d.game.user?.targets);
    if (!targeted.ok) return d.notify(REASON_KEYS[targeted.reason]);
    const targetDoc = targeted.token.document ?? targeted.token;
    const target = combat.combatants.find((c) => c.tokenId === targetDoc.id);
    const verdict = validateTarget({
      targetCombatant: target,
      moverCombatant: mover,
      hostile: !!target && d.areHostile(combat, mover, target),
    });
    if (!verdict.ok) return d.notify(REASON_KEYS[verdict.reason] ?? "TargetNotHostile");

    const gridSize = combat.scene?.grid?.size ?? 100;
    const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
    const distance = d.chebyshevSquares(mover.token, target.token, gridSize);
    const strike = pickMeleeStrike(actor.system?.actions, distance, {
      reachOf: (a) => d.actionReachSquares(a, gridDistanceFt),
      isMelee: d.isMeleeStrikeAction,
    });
    if (!strike) return d.notify("NoStrikeInReach");

    // Let the tracker log the card first, so the MAP count is read from a
    // settled log; the card itself is excluded (it is fixed up afterwards).
    await waitForTrackerLog(mover, (log) => logHasMessage(log, message.id), { sleepFn: d.sleepFn });
    const log = trackerLogOf(mover);
    const cardEntry = Array.isArray(log) ? log.find((e) => e?.msgId === message.id) : null;
    if (cardEntry?.ComplexActionState) {
      // The tracker now models the feat itself; do not double-correct.
      d.log.warn?.(`${TAG} tracker models Vicious Swing as an activity; standing down.`);
      return;
    }
    let variantIndex = 0;
    if (Array.isArray(log)) variantIndex = mapVariantIndex(log.filter((e) => e?.msgId !== message.id));
    else d.notify("MapUnknown");
    const variant = strike.variants[Math.min(variantIndex, strike.variants.length - 1)];

    const targetRef = { document: target.token };
    const sinceMs = d.now();
    // A roll/damage failure must not skip the cost fix: the feat was used.
    await d.withDialogsSuppressed(d.game, async () => {
      const roll = await variant.roll({ target: targetRef, createMessage: true, skipDialog: true });
      const outcome = degreeToOutcome(roll?.degreeOfSuccess ?? roll?.options?.degreeOfSuccess);
      if (!outcome) return;
      const dieSize = weaponDieSize(strike);
      if (!dieSize) {
        d.notify("NoWeaponDie");
        // Still roll plain damage: the Strike hit.
        const plain = { target: targetRef, createMessage: true };
        return outcome === "criticalSuccess" ? strike.critical(plain) : strike.damage(plain);
      }
      let effectIds = [];
      try {
        const created = await actor.createEmbeddedDocuments("Item", [
          buildExtraDiceEffectData({ count: extraDiceCount(actor.level), dieSize }),
        ]);
        effectIds = (created ?? []).map((i) => i.id);
        // PF2e's strike.damage() always rolls as a success; strike.critical() is the crit roll.
        const params = { target: targetRef, createMessage: true, options: [EXTRA_DICE_OPTION] };
        if (outcome === "criticalSuccess") await strike.critical(params);
        else await strike.damage(params);
      } finally {
        if (effectIds.length) {
          try { await actor.deleteEmbeddedDocuments("Item", effectIds); }
          catch (err) { d.log.error?.(`${TAG} could not delete extra-dice effect:`, err?.message ?? err); }
        }
      }
    }).catch((err) => d.log.error?.(`${TAG} Vicious Swing Strike failed:`, err?.message ?? err));

    const strikeMsgId = findStrikeMessageId(d.game.messages?.contents, {
      userId: d.game.user.id, actorId: actor.id, sinceMs,
    });
    await fixTrackerCost({ combatant: mover, cardMsgId: message.id, strikeMsgId }, d);
  } catch (err) {
    d.log.error?.(`${TAG} Vicious Swing handler failed:`, err?.message ?? err);
  }
}

/**
 * updateCombat: when the turn or round changed, sweep a stranded extra-dice
 * effect off the previous combatant's actor (owner's client only).
 */
export async function onViciousSwingCombatUpdate(combat, changes) {
  if (!changes || !("turn" in changes || "round" in changes)) return;
  const prev = combat?.combatants?.get?.(combat.previous?.combatantId);
  if (prev?.actor?.isOwner) await sweepExtraDiceEffects(prev.actor);
}

/** Registers the hooks. Wrapped so Foundry's extra hook arguments never become `deps`. */
export function registerViciousSwingHooks(hooks = globalThis.Hooks) {
  hooks.on("createChatMessage", (message) => onViciousSwingCard(message));
  hooks.on("updateCombat", (combat, changes) => onViciousSwingCombatUpdate(combat, changes));
  hooks.once("ready", async () => {
    for (const actor of globalThis.game?.actors ?? []) {
      if (actor.type === "character" && actor.isOwner) await sweepExtraDiceEffects(actor);
    }
  });
}
