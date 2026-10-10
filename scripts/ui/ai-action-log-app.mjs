import { buildAiLogView, logCombatantLabel } from "./ai-action-log-view.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const APP_ID = "pf2edc-ai-action-log-app";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** #950: whether `el` (the scrollable row list) is at its bottom within
 * `tolerance` px -- decides whether a re-render should auto-scroll, so a
 * user who scrolled up to read an earlier row is never yanked down. */
export function isScrolledToBottom(el, tolerance = 20) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance;
}

/** #950: re-renders an open AiActionLogApp window (module.mjs's combat
 * hooks). `instances` is `foundry.applications.instances`, injectable for
 * tests, same convention as #852's refreshMarchingOrderWindow. Never
 * throws into the combat pipeline. */
export function refreshAiActionLogWindow(instances) {
  try {
    instances?.get?.(APP_ID)?.render();
  } catch (err) {
    console.error(`${MODULE_ID} | #950: refreshing the AI action log failed:`, err?.message);
  }
}

/** #950: whether an `updateCombat` change can alter what the window shows:
 * the log itself, or the combat becoming/stopping being the viewed one or
 * starting. Turn/round changes alone don't change the log. */
export function shouldRefreshAiActionLog(changes) {
  if (!changes || typeof changes !== "object") return false;
  if (changes.flags?.[MODULE_ID] && Object.hasOwn(changes.flags[MODULE_ID], "agentLog")) return true;
  if (changes.flags?.[MODULE_ID] && Object.hasOwn(changes.flags[MODULE_ID], "-=agentLog")) return true;
  return Object.hasOwn(changes, "active") || Object.hasOwn(changes, "started") || Object.hasOwn(changes, "scene");
}

/** #950: the combat whose log is shown -- the viewed combat, when it is one
 * of this module's managed combats (same test as dungeon-combat.mjs's
 * isModuleCombat; only those ever get an agentLog). */
export function aiLogCombat(combat) {
  if (!combat?.getFlag) return null;
  const managed =
    combat.getFlag(MODULE_ID, "dungeonSlot") != null || combat.getFlag(MODULE_ID, "encounterId") != null;
  return managed ? combat : null;
}

/** #950: selects the acting token and pans to it. A silent no-op (false)
 * for a missing id, a token not on the viewed scene (deleted, or another
 * scene), or one the current user cannot see. */
export function panToLogToken(tokenId, cv = globalThis.canvas) {
  try {
    if (!tokenId) return false;
    const token = cv?.tokens?.get?.(tokenId);
    if (!token || !token.visible) return false;
    token.control?.({ releaseOthers: true });
    const center = token.center;
    if (center) cv.animatePan?.({ x: center.x, y: center.y });
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | #950: panning to the token failed:`, err?.message);
    return false;
  }
}

/** #950: `{[combatantId]: {name, img}}` for the combat's combatants, names
 * as this viewer may see them. A combatant removed mid-combat falls through
 * to buildAiLogView's own "Unknown". */
function combatantInfo(combat, isGM) {
  const hideNames = game.pf2e?.settings?.tokens?.nameVisibility === true;
  const out = {};
  for (const c of combat?.combatants ?? []) {
    out[c.id] = {
      name: logCombatantLabel(c, { isGM, hideNames }) ?? "Unknown",
      img: c.img ?? c.token?.texture?.src ?? c.actor?.img ?? null,
    };
  }
  return out;
}

/**
 * #950: the AI Action Log -- every AI action recorded for the current
 * combat (#925's agentLog), filterable by combatant and round, live-updating
 * with auto-scroll, click a row to pan to its token. Open to every user;
 * buildAiLogView decides what each one sees (GM-only rows and the
 * rationale/GM note/fallback tag are the GM's alone). Mirrors #852's
 * MarchingOrderApp shape.
 */
export class AiActionLogApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    tag: "section",
    window: { title: "PF2EDC.AiActionLog.Title", icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 480, height: 460 },
    actions: {
      selectRow: AiActionLogApp.#onSelectRow,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/ai-action-log.hbs` },
  };

  #combatId = null;
  #combatantId = null;
  #round = null;
  #wasAtBottom = true;

  /** Sets the filters: `undefined` keeps one, null/"" clears it. Doesn't
   * render; callers render once afterwards. */
  setFilters({ combatantId, round } = {}) {
    if (combatantId !== undefined) this.#combatantId = combatantId || null;
    if (round !== undefined) this.#round = round === "" || round === null ? null : Number(round);
  }

  get filters() {
    return { combatantId: this.#combatantId, round: this.#round };
  }

  async _prepareContext() {
    const combat = aiLogCombat(game.combat);
    if (!combat) {
      return { hasCombat: false, rows: [], combatants: [], rounds: [], roundOptions: [] };
    }
    // Filters belong to the combat they were chosen in.
    if (this.#combatId !== combat.id) {
      if (this.#combatId !== null) {
        this.#combatantId = null;
        this.#round = null;
      }
      this.#combatId = combat.id;
    }
    const isGM = game.user?.isGM === true;
    const view = buildAiLogView(combat.getFlag(MODULE_ID, "agentLog"), combatantInfo(combat, isGM), {
      combatantId: this.#combatantId,
      round: this.#round,
      isGM,
    });
    return { hasCombat: true, isGM, ...view };
  }

  async _preRender(context, options) {
    await super._preRender?.(context, options);
    const list = this.element?.querySelector?.(".pf2edc-ai-action-log-rows");
    this.#wasAtBottom = list ? isScrolledToBottom(list) : true;
  }

  async _onRender(context, options) {
    await super._onRender?.(context, options);
    const root = this.element;
    const list = root?.querySelector?.(".pf2edc-ai-action-log-rows");
    if (list && this.#wasAtBottom) list.scrollTop = list.scrollHeight;
    root?.querySelector?.('select[data-pf2edc-filter="combatant"]')?.addEventListener("change", (event) => {
      this.setFilters({ combatantId: event.currentTarget.value });
      this.render();
    });
    root?.querySelector?.('select[data-pf2edc-filter="round"]')?.addEventListener("change", (event) => {
      this.setFilters({ round: event.currentTarget.value });
      this.render();
    });
  }

  static #onSelectRow(event, target) {
    panToLogToken(target?.dataset?.tokenId);
  }
}

/** #950: opens the one AiActionLogApp, or re-renders (and re-filters) the
 * already-open one -- never a second window. The module API's entry point,
 * also used by the scene tool, the chat-card link and the macro. */
export function openAiActionLog(
  { combatantId, round } = {},
  { instances = foundry.applications.instances, create = () => new AiActionLogApp() } = {},
) {
  const existing = instances?.get?.(APP_ID);
  const app = existing ?? create();
  app.setFilters({ combatantId, round });
  app.render({ force: true });
  if (existing) existing.bringToFront?.();
  return app;
}

/** #950: the scene-control tool that opens the window -- visible to every
 * user, registered next to #852's marching-order tool. */
export function aiActionLogSceneTool(localize, open = () => openAiActionLog()) {
  return {
    name: "pf2edc-ai-action-log",
    title: localize("PF2EDC.SceneControl.AiActionLogLabel"),
    icon: "fa-solid fa-scroll",
    visible: true,
    button: true,
    // v14 fires button tools through onChange (onClick was the v13 name).
    onChange: () => open(),
    onClick: () => open(),
  };
}

/** #950: binds the "action log" link on #925's per-turn AI card to open the
 * window pre-filtered to that card's combatant (all rounds). */
export function bindAiActionLogCardLink(message, html, open = openAiActionLog) {
  if (!message?.flags?.[MODULE_ID]?.agentTurnCard) return false;
  const link = html?.querySelector?.("[data-pf2edc-open-ai-log]");
  if (!link) return false;
  link.addEventListener("click", (event) => {
    event.preventDefault?.();
    try {
      open({ combatantId: link.dataset?.combatantId || null, round: null });
    } catch (err) {
      console.error(`${MODULE_ID} | #950: opening the AI action log failed:`, err?.message);
    }
  });
  return true;
}
