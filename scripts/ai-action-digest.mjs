/**
 * #951: pure digest-building for an AI combatant's Combat Tracker row and
 * token hover tooltip -- no Foundry API surface. Built on #950's
 * visibleRecords, so the action-log window and these surfaces can never
 * disagree about what a non-GM may see.
 *
 * Records are #925's agentLog entries (see recordAgentAction in
 * dungeon-combat.mjs). `index` counts a combatant's actions within one
 * round; the log itself is append-only, so array order is chronological and
 * is what "latest" means here.
 */
import { visibleRecords } from "./ui/ai-action-log-view.mjs";
import { escapeHtml } from "./agent-action-display.mjs";

const TONES = new Set(["success", "failure", "neutral"]);

function roundOf(record) {
  const n = Number(record?.round);
  return Number.isFinite(n) ? n : null;
}

/** A record's result tone, unknown tones read as neutral. */
export function digestTone(record) {
  return TONES.has(record?.result?.tone) ? record.result.tone : "neutral";
}

/**
 * `records` the combat's agentLog; `combatantId`; `round` the combat's
 * current round; `isGM`. Returns
 * `{ last, currentRound, previousRound, stale }`:
 * - `currentRound`: this combatant's visible records in `round`;
 * - `previousRound`: its records in the latest earlier round that has any;
 * - `last`: `{summary, targetName, result: {text, tone}, round, rationale}`
 *   for its latest record in `round`, or -- when it hasn't acted this round
 *   (`stale`) -- its latest record of all (`rationale` only ever set for a
 *   GM); null when it has no visible records at all.
 * A non-GM never sees a `visibility: "gm"` record or a GM-only field.
 */
export function buildCombatantDigest(records, { combatantId, round, isGM } = {}) {
  const mine = visibleRecords(records, isGM === true).filter((r) => r.combatantId === combatantId);
  if (!mine.length || combatantId == null) return { last: null, currentRound: [], previousRound: [], stale: false };

  const current = Number(round);
  const byIndex = (a, b) => (Number(a.index) || 0) - (Number(b.index) || 0);
  const currentRound = Number.isFinite(current) ? mine.filter((r) => roundOf(r) === current).sort(byIndex) : [];
  const earlier = mine.map(roundOf).filter((n) => n !== null && (!Number.isFinite(current) || n < current));
  const previousNumber = earlier.length ? Math.max(...earlier) : null;
  const previousRound = previousNumber === null ? [] : mine.filter((r) => roundOf(r) === previousNumber).sort(byIndex);

  const stale = currentRound.length === 0;
  const source = stale ? mine[mine.length - 1] : currentRound[currentRound.length - 1];
  const last = {
    summary: typeof source.summary === "string" && source.summary ? source.summary : "Action",
    targetName: source.target?.name ?? null,
    result: { text: source.result?.text ?? "done", tone: digestTone(source) },
    round: roundOf(source),
    rationale: isGM === true && source.rationale ? source.rationale : null,
  };
  return { last, currentRound, previousRound, stale };
}

/** The one-line summary text: "last: Strikes (hit)", "(last round) " first
 * when stale. Plain text -- callers escape it. */
export function digestSummaryText(digest) {
  if (!digest?.last) return "";
  const { summary, targetName, result } = digest.last;
  const target = targetName ? ` → ${targetName}` : "";
  return `${digest.stale ? "(last round) " : ""}last: ${summary}${target} (${result.text})`;
}

function costGlyph(cost) {
  return Number.isInteger(cost) && cost >= 1 && cost <= 3 ? `<span class="action-glyph">${cost}</span> ` : "";
}

/**
 * #951 (shared with #1006's Token HUD panel): one digest row as an `<li>`.
 * Every string is escaped (summaries carry creature names; rationale is
 * free text from an external model). The rationale, GM note, fallback tag
 * and GM-only marker are only ever rendered for a GM, whatever the record
 * carries.
 */
export function renderDigestRowHtml(record, isGM) {
  const gm = isGM === true;
  const tone = digestTone(record);
  const target = record?.target?.name
    ? ` <span class="pf2edc-ai-target">→ ${escapeHtml(record.target.name)}</span>`
    : "";
  const fallback = gm && record?.source === "fallback" ? ` <span class="pf2edc-ai-fallback">(fallback heuristic)</span>` : "";
  const gmOnly = gm && record?.visibility === "gm" ? " pf2edc-ai-gm-only" : "";
  const note = gm && record?.gmNote ? `<div class="pf2edc-ai-note">${escapeHtml(record.gmNote)}</div>` : "";
  const rationale = gm && record?.rationale ? `<div class="pf2edc-ai-rationale">${escapeHtml(record.rationale)}</div>` : "";
  return (
    `<li class="pf2edc-ai-row${gmOnly}">` +
    `${costGlyph(record?.cost)}<strong>${escapeHtml(record?.summary || "Action")}</strong>${target} ` +
    `<span class="pf2edc-ai-result pf2edc-tone-${tone}">${escapeHtml(record?.result?.text ?? "done")}</span>` +
    `${fallback}${note}${rationale}</li>`
  );
}
