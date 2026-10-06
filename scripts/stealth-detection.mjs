/**
 * Pure PF2e Stealth-initiative / detection rules (#616). No Foundry globals and
 * no Foundry-dependent imports: dungeon-combat.mjs feeds it plain data and
 * stores the resulting matrix on the Combat document.
 *
 * Matrix shape: { [sneakerCombatantId]: { [hostileCombatantId]: state } }.
 * A pair absent from the matrix is "observed" (non-sneakers are always
 * targetable).
 */

export const DETECTION = {
  UNNOTICED: "unnoticed",
  UNDETECTED: "undetected",
  HIDDEN: "hidden",
  OBSERVED: "observed",
};

/**
 * Ids of actors whose selected exploration activities include an owned item
 * with the given slug (`system.exploration` lists item ids; the item's slug
 * names the activity). Shared by Avoid Notice (#616) and Search (#755).
 */
export function actorIdsWithExplorationActivity(actors, slug) {
  const ids = [];
  for (const actor of actors ?? []) {
    const selected = new Set(actor.exploration ?? []);
    const active = (actor.items ?? []).some(
      (item) => item.slug === slug && selected.has(item.id),
    );
    if (active) ids.push(actor.id);
  }
  return ids;
}

/**
 * Ids of actors who are Avoiding Notice: their selected exploration activities
 * include an owned item whose slug is "avoid-notice".
 */
export function avoidingNoticeActorIds(actors) {
  return actorIdsWithExplorationActivity(actors, "avoid-notice");
}

/**
 * Compare each sneaker's Stealth result with each hostile's Perception DC
 * (meets or exceeds = unnoticed). Alarm rule: if any pair is observed (or a
 * non-sneaking party member is, `hasObservedNonSneaker`), every
 * unnoticed pair becomes undetected.
 */
export function initialDetection({ sneakers, hostiles, hasObservedNonSneaker = false }) {
  const matrix = {};
  // A party member who is not sneaking is always observed by every hostile.
  let anyObserved = Boolean(hasObservedNonSneaker) && (hostiles ?? []).length > 0;
  for (const sneaker of sneakers ?? []) {
    const row = {};
    for (const hostile of hostiles ?? []) {
      if (sneaker.result >= hostile.dc) {
        row[hostile.id] = DETECTION.UNNOTICED;
      } else {
        row[hostile.id] = DETECTION.OBSERVED;
        anyObserved = true;
      }
    }
    matrix[sneaker.id] = row;
  }
  if (anyObserved) {
    for (const row of Object.values(matrix)) {
      for (const hostileId of Object.keys(row)) {
        if (row[hostileId] === DETECTION.UNNOTICED) row[hostileId] = DETECTION.UNDETECTED;
      }
    }
  }
  return matrix;
}

/** Only observed creatures can be targeted; a missing state counts as observed. */
export function canTargetState(state) {
  return state === undefined || state === null || state === DETECTION.OBSERVED;
}

/** The hostile's view of the sneaker; observed when the pair is not in the matrix. */
export function stateFor(matrix, sneakerId, hostileId) {
  return matrix?.[sneakerId]?.[hostileId] ?? DETECTION.OBSERVED;
}

/**
 * A sneaker attacked: its unnoticed/undetected pairs become hidden (position
 * revealed). Observed and hidden pairs, and other sneakers, are unchanged.
 * Returns a new matrix.
 */
export function afterAttack(matrix, sneakerId) {
  const next = {};
  for (const [id, row] of Object.entries(matrix ?? {})) {
    next[id] = { ...row };
  }
  const row = next[sneakerId];
  if (row) {
    for (const hostileId of Object.keys(row)) {
      if (row[hostileId] === DETECTION.UNNOTICED || row[hostileId] === DETECTION.UNDETECTED) {
        row[hostileId] = DETECTION.HIDDEN;
      }
    }
  }
  return next;
}

/**
 * Seek outcome (RAW): critical success makes hidden/undetected observed;
 * success makes undetected hidden and hidden observed; failures change
 * nothing. Observed and unnoticed are never changed by Seek.
 */
export function applySeekOutcome(state, outcome) {
  if (state !== DETECTION.HIDDEN && state !== DETECTION.UNDETECTED) return state;
  if (outcome === "criticalSuccess") return DETECTION.OBSERVED;
  if (outcome === "success") {
    return state === DETECTION.UNDETECTED ? DETECTION.HIDDEN : DETECTION.OBSERVED;
  }
  return state;
}

/**
 * What a hostile knows about the party. `unaware` means the hostile has
 * sneakers to deal with but none targetable or seekable (all unnoticed).
 */
export function hostileAwareness(matrix, hostileId, partyCombatantIds) {
  const targetable = [];
  const seekable = [];
  let unnoticed = 0;
  for (const id of partyCombatantIds ?? []) {
    const state = stateFor(matrix, id, hostileId);
    if (canTargetState(state)) targetable.push(id);
    else if (state === DETECTION.HIDDEN || state === DETECTION.UNDETECTED) seekable.push(id);
    else unnoticed += 1;
  }
  return {
    targetable,
    seekable,
    unaware: unnoticed > 0 && targetable.length === 0 && seekable.length === 0,
  };
}

/**
 * The single display condition for a sneaker when every hostile agrees on it
 * (unnoticed / undetected / hidden), else null.
 */
export function uniformCondition(matrix, sneakerId) {
  const states = Object.values(matrix?.[sneakerId] ?? {});
  if (states.length === 0) return null;
  const first = states[0];
  if (first === DETECTION.OBSERVED) return null;
  return states.every((s) => s === first) ? first : null;
}
