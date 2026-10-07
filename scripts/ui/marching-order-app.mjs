import { getRunState, effectiveMarchingOrder, setMarchingOrder } from "../dungeon-runner.mjs";
import { requestDungeonAction } from "../dungeon-remote.mjs";
import { canUserSendWidenedAction } from "../dungeon-permissions.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const APP_ID = "pf2edc-marching-order-app";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Whether the current user may reorder: same rule as the relay (GM, run
 * host, or owner of a party character). */
function canReorderNow(state) {
  return canUserSendWidenedAction(
    "setMarchingOrder",
    game.user,
    state,
    game.actors?.party?.members ?? [],
  );
}

/**
 * #852: pure swap of `actorId` with its neighbour (`delta` -1 earlier, +1
 * later) in `order`. Returns the new order, or null for a no-op (unknown
 * actor, or already at that end).
 */
export function reorderMarching(order, actorId, delta) {
  const index = order.indexOf(actorId);
  const swapWith = index + delta;
  if (index === -1 || swapWith < 0 || swapWith >= order.length) return null;
  const reordered = [...order];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  return reordered;
}

/**
 * #852: re-render an open marching-order window (called from module.mjs's
 * dungeonRuns-setting-changed hook). `instances` is
 * `foundry.applications.instances`; kept injectable for testing.
 */
export function refreshMarchingOrderWindow(instances) {
  instances?.get?.(APP_ID)?.render();
}

/**
 * #852: the scene-control tool that opens the window. Visible to every
 * connected user and unconditionally (scene controls are built once per
 * canvas-ready/scene-change cycle, not per run start/end), so the window's
 * own _prepareContext renders the "no active run" empty state.
 */
export function marchingOrderSceneTool(localize, open = () => new MarchingOrderApp().render(true)) {
  return {
    name: "pf2edc-marching-order",
    title: localize("PF2EDC.SceneControl.MarchingOrderLabel"),
    icon: "fa-solid fa-arrows-up-down",
    visible: true,
    button: true,
    onClick: open,
  };
}

/**
 * #852: a small, standalone window for viewing/editing the current dungeon
 * run's marching order, reachable without opening the Dungeon Tracker (which
 * no longer auto-opens, #771/#845). Mirrors SoundPreviewApp's lightweight
 * ApplicationV2 shape. Reordering is relayed exactly as before: the GM
 * writes directly, anyone else entitled (run host or party-character owner,
 * WIDENED_ACTIONS) relays `setMarchingOrder`; other users get a read-only
 * view rather than controls the relay would refuse.
 */
export class MarchingOrderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    tag: "section",
    window: { title: "PF2EDC.MarchingOrder.Title", icon: "fa-solid fa-arrows-up-down" },
    position: { width: 320, height: "auto" },
    actions: {
      moveUp: MarchingOrderApp.#onMoveUp,
      moveDown: MarchingOrderApp.#onMoveDown,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/marching-order-app.hbs` },
  };

  async _prepareContext() {
    const sceneId = canvas?.scene?.id;
    const state = sceneId ? getRunState(sceneId) : null;
    if (!state) return { hasRun: false, canReorder: false, marchingOrder: [] };
    const ids = effectiveMarchingOrder(state);
    return {
      hasRun: true,
      canReorder: canReorderNow(state),
      marchingOrder: ids.map((actorId, index) => ({
        actorId,
        name: game.actors.get(actorId)?.name ?? "?",
        isFirst: index === 0,
        isLast: index === ids.length - 1,
      })),
    };
  }

  static async #onMoveUp(event, target) {
    await MarchingOrderApp.#move(this, target, -1);
  }

  static async #onMoveDown(event, target) {
    await MarchingOrderApp.#move(this, target, 1);
  }

  static async #move(app, target, delta) {
    const sceneId = canvas?.scene?.id;
    const actorId = target?.dataset?.actorId;
    if (!sceneId || !actorId) return;
    const state = getRunState(sceneId);
    if (!state) return;
    // Defence in depth: the relay would refuse anyone else anyway.
    if (!canReorderNow(state)) return;
    const reordered = reorderMarching(effectiveMarchingOrder(state), actorId, delta);
    if (!reordered) return;
    if (game.user.isGM) {
      await setMarchingOrder(sceneId, reordered);
    } else {
      await requestDungeonAction("setMarchingOrder", { sceneId, orderedActorIds: reordered });
    }
    app.render();
  }
}
