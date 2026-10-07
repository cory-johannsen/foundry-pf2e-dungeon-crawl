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

import { isPositionChange } from "./placement.mjs";

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

/** Draws a small "Flanked" pill as a named child of the token placeable
 * (bottom-left), so it follows the token's animation, is hidden with the
 * token, and is destroyed with it. */
export function createPixiBadge(placeable) {
  const container = new PIXI.Container();
  container.name = BADGE_NAME;
  container.eventMode = "none";

  const style = CONFIG.canvasTextStyle.clone();
  style.fontSize = Math.max(14, Math.round(canvas.grid.size / 6));
  style.fill = 0xffffff;
  style.stroke = 0x000000;
  const label = new foundry.canvas.containers.PreciseText(
    game.i18n.localize("PF2EDC.Dungeon.Combat.FlankedBadge"),
    style,
  );
  const padX = 6;
  const padY = 3;
  label.anchor.set(0, 0);
  label.position.set(padX, padY);

  const pill = new PIXI.Graphics();
  pill.beginFill(0xb3261e, 0.92);
  pill.lineStyle(2, 0xffffff, 0.9);
  pill.drawRoundedRect(0, 0, label.width + padX * 2, label.height + padY * 2, 6);
  pill.endFill();

  container.addChild(pill);
  container.addChild(label);

  const tokenHeight =
    placeable.h ?? (placeable.document?.height ?? 1) * canvas.grid.size;
  container.position.set(2, tokenHeight - (label.height + padY * 2) - 2);
  placeable.addChild(container);

  return {
    destroy() {
      if (!container.destroyed) container.destroy({ children: true });
    },
    isAttached(p) {
      return !container.destroyed && container.parent === p;
    },
  };
}

/** Token placeables the flanking pass scans for `combat` (#875): a defeated
 * combatant is neither a flanker nor flanked, so its token is excluded
 * (the combatant's own `isDefeated`, as the combat code uses); a combatant
 * with no linked token is skipped. */
export function flankingPlaceablesFor(combat) {
  return combat.combatants
    .filter((c) => !c.isDefeated)
    .map((c) => c.token?.object)
    .filter(Boolean);
}

/** Registers the hooks that keep each client's badges in sync. Every client
 * runs its own indicator: nothing is written, so there is no GM gating. */
export function registerFlankedIndicator() {
  const indicator = createFlankedIndicator({
    getCombat: () => {
      const combat = game.combat;
      return combat?.started && combat.scene?.id === canvas?.scene?.id
        ? combat
        : null;
    },
    getPlaceables: flankingPlaceablesFor,
    createBadge: createPixiBadge,
    // setTimeout, not requestAnimationFrame: rAF never fires in a hidden
    // browser tab (e.g. the foundry-rest relay tab).
    defer: (fn) => setTimeout(fn, 50),
    onError: (err) =>
      console.error(`${MODULE_ID} | flanked indicator refresh failed`, err),
  });

  // Flanking is a three-body relationship: any token's move/visibility/size
  // change can change a DIFFERENT token's state, so every one of these
  // schedules a recompute of the whole combat.
  Hooks.on("updateToken", (doc, changes) => {
    if (doc.parent?.id !== canvas?.scene?.id) return;
    if (
      isPositionChange(changes) ||
      changes.hidden !== undefined ||
      changes.width !== undefined ||
      changes.height !== undefined ||
      changes.elevation !== undefined
    )
      indicator.schedule();
  });
  // A redraw can discard our child; the manager re-creates a detached badge.
  Hooks.on("refreshToken", (_token, flags) => {
    if (flags?.redraw || flags?.refreshVisibility) indicator.schedule();
  });
  // #875: defeat is a Combatant `defeated` update (fires updateCombatant);
  // without it the badge only clears on some unrelated later event.
  for (const hook of [
    "updateCombat",
    "updateCombatant",
    "createCombatant",
    "deleteCombatant",
  ])
    Hooks.on(hook, () => indicator.schedule());
  Hooks.on("canvasReady", () => indicator.schedule());
  // Combat deleted by ANY path, or the canvas going away: drop every badge now.
  Hooks.on("deleteCombat", () => indicator.clear());
  Hooks.on("canvasTearDown", () => indicator.clear());

  return indicator;
}
