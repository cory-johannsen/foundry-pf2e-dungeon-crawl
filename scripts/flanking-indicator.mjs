/**
 * Flanked badge (#769): a purely visual, client-side "Flanked" badge on
 * every flanked token during combat. It writes nothing -- no condition, no
 * flag, no effect item -- so it cannot disagree with attack rolls, race
 * with other clients, or leave stale state behind. Flanking itself is
 * decided by PF2e's own `Token#isFlanking` (the same geometry attack rolls
 * use), never reimplemented here.
 *
 * The first design toggled PF2e's real `off-guard` condition; review found
 * that applies off-guard to EVERY attacker (ranged, non-flankers), broader
 * than PF2e's flanking rule (the flankers' melee Strikes only), so the
 * user chose this visual-only version instead.
 */

const MODULE_ID = "pf2e-dungeon-crawl";
const BADGE_NAME = "pf2edc-flanked";

function safeIsFlanking(flanker, target) {
  try {
    return !!flanker.isFlanking(target);
  } catch {
    return false; // a token mid-destroy etc.: treat as not flanking
  }
}

/** Ids of the placeables that at least one OTHER placeable is flanking.
 * Both sides need an `id` and an `actor`. */
export function computeFlankedTokenIds(placeables) {
  const flanked = new Set();
  for (const target of placeables) {
    if (!target?.id || !target.actor) continue;
    const isFlanked = placeables.some(
      (other) =>
        other !== target &&
        other?.actor &&
        typeof other.isFlanking === "function" &&
        safeIsFlanking(other, target),
    );
    if (isFlanked) flanked.add(target.id);
  }
  return flanked;
}

/** Owns the badges for one client. `deps`: `getCombat()` -> the started
 * combat for the viewed scene or null; `getPlaceables(combat)` -> the
 * combat's token placeables; `createBadge(placeable)` -> `{ destroy(),
 * isAttached(placeable) }`; `defer(fn)` schedules `fn` shortly (must work
 * in a hidden tab); `onError(err)` receives a failed deferred refresh. */
export function createFlankedIndicator(deps) {
  const badges = new Map(); // tokenId -> badge

  function clear() {
    for (const badge of badges.values()) badge.destroy();
    badges.clear();
  }

  function refresh() {
    const combat = deps.getCombat();
    if (!combat) {
      clear();
      return;
    }
    const placeables = deps.getPlaceables(combat);
    const flanked = computeFlankedTokenIds(placeables);
    const present = new Set(placeables.map((p) => p.id));

    for (const [id, badge] of [...badges]) {
      if (!flanked.has(id) || !present.has(id)) {
        badge.destroy();
        badges.delete(id);
      }
    }
    for (const placeable of placeables) {
      if (!flanked.has(placeable.id)) continue;
      const existing = badges.get(placeable.id);
      if (existing?.isAttached(placeable)) continue;
      existing?.destroy(); // detached (token was redrawn): replace it
      badges.set(placeable.id, deps.createBadge(placeable));
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    deps.defer(() => {
      scheduled = false;
      try {
        refresh();
      } catch (err) {
        deps.onError?.(err);
      }
    });
  }

  return { refresh, schedule, clear, badgeCount: () => badges.size };
}
