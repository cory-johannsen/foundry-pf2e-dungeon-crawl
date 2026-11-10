/**
 * #1281: pure decision logic for the player Vicious Swing automation. No
 * Foundry globals; the I/O lives in vicious-swing.mjs.
 */
export const VICIOUS_SWING_SLUG = "vicious-swing";
export const EXTRA_DICE_OPTION = "vicious-swing:extra-dice";
export const EXTRA_DICE_EFFECT_SLUG = "vicious-swing-extra-dice";

/** True for the Vicious Swing feat's own chat card (not a roll it made). */
export function isViciousSwingMessage(message) {
  const pf2e = message?.flags?.pf2e;
  if (!pf2e || pf2e.context) return false;
  if (pf2e.origin?.type !== "feat") return false;
  const options = pf2e.origin.rollOptions;
  return Array.isArray(options) && options.includes(`origin:item:slug:${VICIOUS_SWING_SLUG}`);
}

/** Extra weapon dice: 1 below level 10, 2 at 10-17, 3 at 18+. */
export function extraDiceCount(level) {
  const l = Number(level);
  if (!Number.isFinite(l)) return 1;
  return l >= 18 ? 3 : l >= 10 ? 2 : 1;
}

export function weaponDieSize(strikeAction) {
  return strikeAction?.item?.system?.damage?.die || null;
}

/** Effect item source carrying a roll-option-gated DamageDice rule element. */
export function buildExtraDiceEffectData({ count, dieSize }) {
  return {
    name: "Vicious Swing (extra dice)",
    type: "effect",
    img: "icons/svg/sword.svg",
    system: {
      slug: EXTRA_DICE_EFFECT_SLUG,
      rules: [{
        key: "DamageDice",
        selector: "strike-damage",
        diceNumber: count,
        dieSize,
        predicate: [EXTRA_DICE_OPTION],
      }],
      duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
      tokenIcon: { show: false },
    },
  };
}

/** Tracker edits that make the swing cost 2 actions and count as 2 attacks. */
export function costFixUpdates() {
  return { card: { isMapRelevant: true }, strike: { cost: 0 } };
}

/** Newest attack-roll message by this user/actor created at or after sinceMs. */
export function findStrikeMessageId(messages, { userId, actorId, sinceMs }) {
  let best = null;
  for (const m of messages ?? []) {
    if (m?.author?.id !== userId) continue;
    if (m.speaker?.actor !== actorId) continue;
    if (m.flags?.pf2e?.context?.type !== "attack-roll") continue;
    if ((m.timestamp ?? 0) < sinceMs) continue;
    if (!best || (m.timestamp ?? 0) >= (best.timestamp ?? 0)) best = m;
  }
  return best?.id ?? null;
}

export function sweepableEffectIds(items) {
  return [...(items ?? [])].filter((i) => i?.slug === EXTRA_DICE_EFFECT_SLUG).map((i) => i.id);
}

/** Whether a list of tracker library slugs already models Vicious Swing. */
export function trackerHasViciousSwingEntry(slugs) {
  return (slugs ?? []).includes(VICIOUS_SWING_SLUG);
}
