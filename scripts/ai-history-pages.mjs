/**
 * #953: pure builders for the run-wide AI action history -- the HTML of the
 * two journal pages one archived combat becomes (a public page and a GM-only
 * page), the page title ("Room 4 — Combat" / "Encounter — <scene>") and the
 * journal names. No Foundry API surface, so the redaction rule (the public
 * page never carries a GM-only row or field) is testable on its own.
 *
 * Records are #925's agentLog records (see ai-action-log-view.mjs). The
 * public page goes through #950's `visibleRecords(records, false)` -- the one
 * shared definition of what a player may see -- so it drops every
 * `visibility: "gm"` row and every GM-only field (rationale, gmNote, source,
 * alternatives, meta, fallbackReason) before a single cell is built. The GM
 * page shows every record plus #952's decision details through the same
 * `buildDecisionDetails`/`renderDecisionDetailsHtml` pair the chat card, the
 * log window and the tracker row use.
 *
 * Every interpolated string is escaped here; nothing from a record is ever
 * emitted as raw HTML (live-checked on Foundry 14.368: the table, list,
 * em/strong and <details> markup below survives a JournalEntryPage write
 * unchanged, while a <script> is stripped server-side anyway).
 */
import { visibleRecords } from "./ui/ai-action-log-view.mjs";
import { buildDecisionDetails, renderDecisionDetailsHtml } from "./ui/ai-decision-details.mjs";

const TONES = new Set(["success", "failure", "neutral"]);
/** Same exclusion the tracker's own room counter uses (ui/dungeon-app.mjs). */
const UNCOUNTED_ROOM_KINDS = new Set(["safe_entry", "safe_rest"]);
export const EMPTY_PAGE_HTML = "<p>No AI actions were recorded for this encounter.</p>";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toRound(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Records grouped by round, rounds ascending, each group in append
 * (chronological) order -- `index` is per (combatant, round), so it is NOT
 * a turn order and is never sorted on. Records without a round go last. */
function groupByRound(records) {
  const groups = new Map();
  for (const r of records) {
    const round = toRound(r.round);
    if (!groups.has(round)) groups.set(round, []);
    groups.get(round).push(r);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });
}

function nameOf(names, combatantId) {
  const name = names?.[combatantId];
  return typeof name === "string" && name ? name : "Unknown";
}

function resultCell(record) {
  const tone = TONES.has(record.result?.tone) ? record.result.tone : "neutral";
  const text = record.result?.text || "done";
  return `<span class="pf2edc-ai-history-result pf2edc-ai-history-result-${tone}">${escapeHtml(text)}</span>`;
}

function rowCells(record, names) {
  const summary = typeof record.summary === "string" && record.summary ? record.summary : "Action";
  return (
    `<td>${escapeHtml(nameOf(names, record.combatantId))}</td>` +
    `<td>${escapeHtml(summary)}</td>` +
    `<td>${escapeHtml(record.target?.name ?? "")}</td>` +
    `<td>${resultCell(record)}</td>`
  );
}

const TABLE_HEAD = "<thead><tr><th>Actor</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>";

function roundHeading(round) {
  return round === null ? "<h3>Unknown round</h3>" : `<h3>Round ${round}</h3>`;
}

/**
 * The public page: what each AI did and the result, per round. `records`
 * the combat's agentLog (anything that isn't an array reads as empty);
 * `names` `{[combatantId]: name}` -- the names PLAYERS may see (the caller
 * applies PF2e's token-name visibility). GM-only rows and fields never get
 * here: the records are reduced by `visibleRecords(records, false)` first.
 */
export function buildPublicPageHtml(records, { names = {} } = {}) {
  const rows = visibleRecords(records, false);
  if (!rows.length) return EMPTY_PAGE_HTML;
  return groupByRound(rows)
    .map(
      ([round, group]) =>
        `${roundHeading(round)}<table class="pf2edc-ai-history">${TABLE_HEAD}<tbody>` +
        group.map((r) => `<tr>${rowCells(r, names)}</tr>`).join("") +
        `</tbody></table>`,
    )
    .join("");
}

/**
 * The GM page: every record (including a hidden actor's GM-only rows,
 * marked), each followed by its rationale, GM note, the fallback tag and
 * #952's details (alternatives considered, decision metadata, fallback
 * reason). `names` the real combatant names.
 */
export function buildGmPageHtml(records, { names = {} } = {}) {
  const rows = visibleRecords(records, true);
  if (!rows.length) return EMPTY_PAGE_HTML;
  return groupByRound(rows)
    .map(([round, group]) => {
      const body = group
        .map((r) => {
          const tags = [];
          if (r.visibility === "gm") tags.push("hidden from players");
          if (r.source === "fallback") tags.push("fallback heuristic");
          const extras = [];
          if (tags.length) extras.push(`<p><em>(${escapeHtml(tags.join(", "))})</em></p>`);
          if (r.rationale) extras.push(`<p><strong>Rationale:</strong> ${escapeHtml(r.rationale)}</p>`);
          if (r.gmNote) extras.push(`<p><strong>GM note:</strong> ${escapeHtml(r.gmNote).replace(/\n/g, "<br>")}</p>`);
          const details = renderDecisionDetailsHtml(buildDecisionDetails(r, { isGM: true }));
          if (details) extras.push(details);
          return `<tr>${rowCells(r, names)}</tr>` + (extras.length ? `<tr><td colspan="4">${extras.join("")}</td></tr>` : "");
        })
        .join("");
      return `${roundHeading(round)}<table class="pf2edc-ai-history">${TABLE_HEAD}<tbody>${body}</tbody></table>`;
    })
    .join("");
}

/**
 * The page title for an archived combat. A dungeon combat (`roomId` = its
 * `dungeonSlot` flag, a room id) is "Room N — <kind>", N counted the way the
 * tracker counts (the party's path through `state.history` plus this room,
 * entry and rest rooms not counted); a room that isn't counted, or one the
 * run state doesn't know, is just its kind / "Room". A standalone combat
 * (no room) is "Encounter — <scene name>". `kindLabel(kind)` localizes a
 * room kind.
 */
export function encounterLabel({ roomId = null, runState = null, sceneName = null, kindLabel = (k) => k } = {}) {
  if (roomId != null) {
    const rooms = runState?.rooms && typeof runState.rooms === "object" ? runState.rooms : {};
    const room = rooms[roomId];
    if (!room) return "Room";
    const kind = kindLabel(room.kind) || "Room";
    if (UNCOUNTED_ROOM_KINDS.has(room.kind)) return kind;
    const path = (Array.isArray(runState.history) ? runState.history : []).map((h) => h?.roomId);
    if (!path.includes(roomId)) path.push(roomId);
    const n = path.filter((id) => rooms[id] && !UNCOUNTED_ROOM_KINDS.has(rooms[id].kind)).indexOf(roomId) + 1;
    return n > 0 ? `Room ${n} — ${kind}` : kind;
  }
  return sceneName ? `Encounter — ${sceneName}` : "Encounter";
}

/** "<scene name> (<run start>)" -- every dungeon scene is named "Dungeon
 * Crawl", so the run's start time is what tells two runs' journals apart. */
export function runDisplayName(sceneName, createdAt) {
  const base = sceneName || "Dungeon Run";
  if (!Number.isFinite(createdAt)) return base;
  const d = new Date(createdAt);
  const pad = (n) => String(n).padStart(2, "0");
  return `${base} (${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())})`;
}

export function publicJournalName(displayName) {
  return `AI Action History — ${displayName}`;
}

export function gmJournalName(displayName) {
  return `AI Action Details — ${displayName} (GM)`;
}
