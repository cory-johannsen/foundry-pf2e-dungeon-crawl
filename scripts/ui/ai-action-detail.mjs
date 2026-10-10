/**
 * #951: an AI combatant's latest actions where the table is already looking
 * -- a one-line summary (click to expand) under its Combat Tracker row, and
 * a small tooltip when its token is hovered on the canvas. Both read #925's
 * `agentLog` combat flag through buildCombatantDigest (and so #950's shared
 * visibleRecords rule): everyone sees what was done and the result; the
 * rationale, GM notes, fallback tag and hidden-token actors are the GM's
 * alone. Read-only display: nothing here writes a document, and every hook
 * handler swallows (and logs) its own errors so the tracker, the canvas and
 * the combat pipeline never see them.
 *
 * Foundry v14 shapes this relies on (checked live on 14.368 / pf2e 8.5.0):
 * - the tracker (pf2e's EncounterTracker < CombatTracker < ApplicationV2)
 *   fires `renderCombatTracker(app, element)` for every render, including
 *   the full re-render a combat flag update causes (DocumentCollection
 *   #_onModifyContents -> game.combats.apps); `app.viewed` is the combat it
 *   shows;
 * - each row is `li.combatant[data-combatant-id][data-action="activateCombatant"]`
 *   with a `.token-name` block; ApplicationV2's delegated click handler and
 *   CombatTracker's own dblclick listener sit on the app element, so the
 *   summary line stops its own click/dblclick from reaching them;
 * - `hoverToken(token, hovered)` (PlaceableObject#_onHoverIn/_onHoverOut);
 * - `canvas.clientCoordinatesFromCanvas(point)` = the stage worldTransform
 *   applied to a scene point, in CSS pixels relative to the #board canvas.
 */
import { buildCombatantDigest, digestSummaryText, digestTone, renderDigestRowHtml } from "../ai-action-digest.mjs";
import { escapeHtml } from "../agent-action-display.mjs";
import { logCombatantLabel } from "./ai-action-log-view.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const LINE_CLASS = "pf2edc-ai-last";
const OVERLAY_ID = "pf2edc-ai-hover";

function agentLogOf(combat) {
  try {
    return combat?.getFlag?.(MODULE_ID, "agentLog");
  } catch {
    return null;
  }
}

/**
 * Inserts (or refreshes) the AI-action summary line under every combatant
 * row in `root` whose combatant has a digest this viewer may see; rows
 * without one are left untouched. A row whose id is in `expandedIds` also
 * shows its current/previous-round actions. Idempotent: a row's previous
 * line is removed before the new one goes in. Clicking a line toggles its
 * id in `expandedIds` (a Set the caller keeps across tracker re-renders)
 * and re-renders the lines.
 */
export function renderTrackerDigestInto(root, combat, isGM, expandedIds = new Set()) {
  if (!root?.querySelectorAll) return;
  const records = agentLogOf(combat);
  const gm = isGM === true;
  const doc = root.ownerDocument ?? globalThis.document;
  for (const row of root.querySelectorAll("li[data-combatant-id]")) {
    for (const old of row.querySelectorAll(`.${LINE_CLASS}`)) old.remove();
    const combatantId = row.dataset.combatantId;
    const digest = buildCombatantDigest(records, { combatantId, round: combat?.round, isGM: gm });
    if (!digest.last) continue;

    const expanded = expandedIds.has(combatantId);
    const line = doc.createElement("div");
    line.className = `${LINE_CLASS}${expanded ? " expanded" : ""}`;
    line.dataset.pf2edcAiCombatant = combatantId;
    line.innerHTML =
      `<a class="pf2edc-ai-last-summary pf2edc-tone-${digest.last.result.tone}" role="button" aria-expanded="${expanded}">` +
      `<i class="fa-solid fa-chevron-${expanded ? "down" : "right"} fa-fw"></i> ${escapeHtml(digestSummaryText(digest))}</a>`;
    if (expanded) {
      const list = doc.createElement("div");
      list.className = "pf2edc-ai-expanded";
      const rows = (rs) => `<ul class="pf2edc-ai-rows">${rs.map((r) => renderDigestRowHtml(r, gm)).join("")}</ul>`;
      list.innerHTML =
        (digest.currentRound.length ? rows(digest.currentRound) : "") +
        (digest.previousRound.length
          ? `<p class="pf2edc-ai-previous-round-label">Last round</p>${rows(digest.previousRound)}`
          : "");
      line.appendChild(list);
    }
    // Keep the click/dblclick off the row's own activateCombatant action
    // (pan + control) and its dblclick (open the sheet).
    line.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (expandedIds.has(combatantId)) expandedIds.delete(combatantId);
      else expandedIds.add(combatantId);
      renderTrackerDigestInto(root, combat, gm, expandedIds);
    });
    line.addEventListener("dblclick", (event) => event.stopPropagation());
    (row.querySelector(".token-name") ?? row).appendChild(line);
  }
}

function overlayElement(doc, create) {
  let el = doc?.getElementById?.(OVERLAY_ID) ?? null;
  if (!el && create && doc?.body) {
    el = doc.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("role", "tooltip");
    el.style.position = "fixed";
    el.style.pointerEvents = "none";
    el.style.display = "none";
    doc.body.appendChild(el);
  }
  return el;
}

/** Hides the hover tooltip (never removes it; it is reused). */
export function hideHoverOverlay(doc = globalThis.document) {
  const el = overlayElement(doc, false);
  if (el) el.style.display = "none";
}

/** A scene point -> page (client) coordinates, or null when it can't be
 * converted (no canvas, a non-finite result). */
export function canvasPointToClient(point, cv = globalThis.canvas) {
  try {
    if (!point || !cv) return null;
    let local;
    if (typeof cv.clientCoordinatesFromCanvas === "function") {
      local = cv.clientCoordinatesFromCanvas({ x: point.x, y: point.y });
    } else {
      local = cv.stage.worldTransform.apply({ x: point.x, y: point.y });
    }
    const rect = cv.app?.view?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const x = (rect.left ?? 0) + local.x;
    const y = (rect.top ?? 0) + local.y;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

/** The scene point the tooltip is anchored to: the token's top-right
 * corner, or its center when it has no bounds. */
function anchorPoint(token) {
  const b = token?.bounds;
  if (b && Number.isFinite(b.x) && Number.isFinite(b.width)) return { x: b.x + b.width, y: b.y };
  return token?.center ?? null;
}

/**
 * Shows the hover tooltip for `token` (a canvas Token placeable), or hides
 * it when there is nothing this viewer may see: a token they can't see, a
 * token with no combatant, a combatant hidden from players (non-GM), or no
 * visible digest (a human-controlled combatant has no records), or when its
 * position can't be converted. `combat` defaults to the token combatant's
 * own combat. Returns whether the tooltip is shown.
 */
export function renderHoverOverlay(token, combat, isGM, { doc = globalThis.document, cv = globalThis.canvas, hideNames = false } = {}) {
  try {
    const gm = isGM === true;
    if (!token || token.visible === false) return hide(doc);
    const combatant = token.combatant ?? token.document?.combatant ?? null;
    if (!combatant) return hide(doc);
    if (!gm && combatant.hidden === true) return hide(doc);
    const theCombat = combat ?? combatant.parent ?? combatant.combat ?? null;
    const digest = buildCombatantDigest(agentLogOf(theCombat), { combatantId: combatant.id, round: theCombat?.round, isGM: gm });
    if (!digest.last) return hide(doc);
    const client = canvasPointToClient(anchorPoint(token), cv);
    if (!client) return hide(doc);

    const el = overlayElement(doc, true);
    if (!el) return false;
    const name = logCombatantLabel(combatant, { isGM: gm, hideNames }) ?? "Unknown";
    const { last } = digest;
    const target = last.targetName ? ` → ${escapeHtml(last.targetName)}` : "";
    el.innerHTML =
      `<strong class="pf2edc-ai-hover-name">${escapeHtml(name)}</strong>` +
      `<div class="pf2edc-ai-hover-line">${digest.stale ? '<span class="pf2edc-ai-stale">(last round)</span> ' : ""}` +
      `${escapeHtml(last.summary)}${target} ` +
      `<span class="pf2edc-ai-result pf2edc-tone-${digestTone(last)}">${escapeHtml(last.result.text)}</span></div>` +
      (gm && last.rationale ? `<div class="pf2edc-ai-rationale">${escapeHtml(last.rationale)}</div>` : "");
    el.dataset.tokenId = token.id ?? "";
    el.style.left = `${Math.round(client.x + 8)}px`;
    el.style.top = `${Math.round(client.y)}px`;
    el.style.display = "block";
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | #951: AI hover tooltip failed:`, err?.message);
    return hide(doc);
  }
}

function hide(doc) {
  hideHoverOverlay(doc);
  return false;
}

/**
 * Registers the tracker-row and hover hooks (module.mjs, at load). `deps`
 * is injectable for tests: `hooks` (Foundry's Hooks), `getUser()`,
 * `getCombat()` (the fallback combat), `getHideNames()`, `doc`, `getCanvas()`.
 * Returns `{expandedIds}` for tests.
 */
export function registerAiActionDetail({
  hooks = globalThis.Hooks,
  getUser = () => globalThis.game?.user,
  getCombat = () => globalThis.game?.combat ?? null,
  getHideNames = () => globalThis.game?.pf2e?.settings?.tokens?.nameVisibility === true,
  doc = globalThis.document,
  getCanvas = () => globalThis.canvas,
} = {}) {
  const expandedIds = new Set();
  let expandedCombatId = null;
  let hovered = null;

  const isGM = () => getUser()?.isGM === true;
  const show = (token) => renderHoverOverlay(token, null, isGM(), { doc, cv: getCanvas(), hideNames: getHideNames() });
  const unhover = () => {
    hovered = null;
    hideHoverOverlay(doc);
  };

  hooks.on("renderCombatTracker", (app, element) => {
    try {
      // v14 passes the HTMLElement; a jQuery-wrapped one (pre-v13) is unwrapped.
      const root = typeof element?.querySelectorAll === "function" ? element : element?.[0];
      const combat = app?.viewed !== undefined ? app.viewed : getCombat();
      if (!root || !combat) return;
      // The expanded rows belong to the combat they were opened in.
      if (combat.id !== expandedCombatId) {
        expandedIds.clear();
        expandedCombatId = combat.id ?? null;
      }
      renderTrackerDigestInto(root, combat, isGM(), expandedIds);
    } catch (err) {
      console.error(`${MODULE_ID} | #951: AI tracker detail failed:`, err?.message);
    }
  });

  hooks.on("hoverToken", (token, isHovered) => {
    if (!isHovered) {
      if (!hovered || hovered === token) unhover();
      return;
    }
    hovered = show(token) ? token : null;
  });
  // Follow the hovered token across pans/zooms and its own movement; a new
  // log record while hovering refreshes the text.
  hooks.on("canvasPan", () => {
    if (hovered) hovered = show(hovered) ? hovered : null;
  });
  hooks.on("refreshToken", (token) => {
    if (hovered && token === hovered) hovered = show(hovered) ? hovered : null;
  });
  hooks.on("updateCombat", (combat, changes) => {
    if (hovered && changes?.flags?.[MODULE_ID] && Object.hasOwn(changes.flags[MODULE_ID], "agentLog")) {
      hovered = show(hovered) ? hovered : null;
    }
  });
  hooks.on("deleteToken", (tokenDoc) => {
    if (!hovered || hovered.id === tokenDoc?.id || hovered.document === tokenDoc) unhover();
  });
  hooks.on("deleteCombat", (combat) => {
    unhover();
    if (!combat || combat.id === expandedCombatId) {
      expandedIds.clear();
      expandedCombatId = null;
    }
  });
  hooks.on("canvasTearDown", unhover);

  return { expandedIds };
}
