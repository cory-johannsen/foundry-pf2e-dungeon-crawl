/**
 * #1278: pure decision logic for the player Defensive Advance automation
 * (Raise Shield at feat use + auto-Strike when the first movement ends in
 * melee reach). No imports and no Foundry globals, so it unit-tests alone;
 * the Foundry I/O lives in defensive-advance.mjs.
 *
 * Tracker facts this relies on (pf2e-auto-action-tracker v0.19.1): its
 * per-combatant log entries carry `msgId`, `isMapRelevant`, `type`,
 * `actionModifiers`, and for an activity a `ComplexActionState` with
 * `leaves` ({type, childActions}) and `orderedActivityChildActions`.
 */
export const DEFENSIVE_ADVANCE_SLUG = "defensive-advance";
export const TRACKER_NAMESPACE = "pf2e-auto-action-tracker";

const REACH_EPSILON = 1e-6;

/** True for the Defensive Advance feat's own chat card (not a roll it made). */
export function isDefensiveAdvanceMessage(message) {
  const pf2e = message?.flags?.pf2e;
  if (!pf2e || pf2e.context) return false;
  if (pf2e.origin?.type !== "feat") return false;
  const options = pf2e.origin.rollOptions;
  return Array.isArray(options) && options.includes(`origin:item:slug:${DEFENSIVE_ADVANCE_SLUG}`);
}

// --- pending state (client-local; one entry per token) --------------------

export const createPendingStore = () => new Map();

export function armPending(store, entry) {
  store.set(entry.tokenId, { ...entry });
}

export function peekPending(store, tokenId) {
  return store.get(tokenId) ?? null;
}

export function consumePending(store, tokenId) {
  const entry = store.get(tokenId) ?? null;
  store.delete(tokenId);
  return entry;
}

export function clearPendingWhere(store, predicate) {
  let removed = 0;
  for (const [key, value] of store) {
    if (predicate(value)) {
      store.delete(key);
      removed++;
    }
  }
  return removed;
}

// --- target ----------------------------------------------------------------

/** Exactly one targeted token, or the reason there isn't. */
export function resolveTargetToken(userTargets) {
  const list = userTargets ? [...userTargets] : [];
  if (list.length === 0) return { ok: false, reason: "none" };
  if (list.length > 1) return { ok: false, reason: "many" };
  return { ok: true, token: list[0] };
}

export function validateTarget({ targetCombatant, moverCombatant, hostile }) {
  if (!targetCombatant) return { ok: false, reason: "not-in-combat" };
  if (targetCombatant.id === moverCombatant?.id) return { ok: false, reason: "self" };
  if (targetCombatant.isDefeated) return { ok: false, reason: "defeated" };
  if (!hostile) return { ok: false, reason: "not-hostile" };
  return { ok: true };
}

/** The ready melee Strike with the best modifier that reaches the target. */
export function pickMeleeStrike(actions, distanceSquares, { reachOf, isMelee }) {
  const usable = (actions ?? []).filter(
    (a) =>
      a?.type === "strike" &&
      a.ready !== false &&
      isMelee(a) &&
      distanceSquares <= reachOf(a) + REACH_EPSILON,
  );
  usable.sort((a, b) => (b.totalModifier ?? 0) - (a.totalModifier ?? 0));
  return usable[0] ?? null;
}

// --- multiple attack penalty (mirrors the tracker's getCurrentMapStateFromLog) --

export function countMapAttacks(log) {
  const flat = (log ?? []).flatMap((entry) => {
    const state = entry?.ComplexActionState;
    if (!state) return [entry];
    const children = (state.orderedActivityChildActions ?? []).flatMap((child) =>
      child?.actionModifiers?.includes("mapIncrease2") ? [child, child] : [child],
    );
    return [...(entry.isMapRelevant ? [entry] : []), ...children];
  });
  return flat.filter(
    (e) => e?.isMapRelevant === true && e.type !== "reaction" && !e.actionModifiers?.includes("deferMAP"),
  ).length;
}

/** Index into a Strike's `variants` (0 = no penalty, 1 = MAP 1, 2 = MAP 2). */
export function mapVariantIndex(log) {
  return Math.min(countMapAttacks(log), 2);
}

// --- tracker log predicates ---------------------------------------------------

export function logHasMessage(log, msgId) {
  return (log ?? []).some((e) => e?.msgId === msgId);
}

/** Whether the tracker has claimed a Stride/move for the feat's open activity. */
export function activityHasMoveChild(log, featMsgId) {
  const entry = (log ?? []).find((e) => e?.msgId === featMsgId);
  const leaves = entry?.ComplexActionState?.leaves;
  if (!leaves) return false;
  return Object.values(leaves).some((l) => l?.type === "move" && (l.childActions ?? []).length > 0);
}

/** PF2e check degree of success (0-3) to the outcome string Strike damage takes. */
export function degreeToOutcome(degree) {
  if (degree === 3) return "criticalSuccess";
  if (degree === 2) return "success";
  return null;
}
