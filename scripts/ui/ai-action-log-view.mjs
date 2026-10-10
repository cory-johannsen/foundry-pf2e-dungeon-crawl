/**
 * #950: pure view-building for the AI Action Log window -- no Foundry API
 * surface, so the redaction rule (GM-only rows/fields never reach a non-GM)
 * is testable apart from the app shell that renders it.
 *
 * Input records are the ones #925's recordAgentAction (dungeon-combat.mjs)
 * appends to `flags.pf2e-dungeon-crawl.agentLog` on the Combat:
 * `{combatantId, tokenId, round, turn, index, candidateId, type, kind, cost,
 * summary, target: {id, name}|null, result: {text, tone}, gmNote, rationale,
 * source: "model"|"fallback", visibility: "all"|"gm"}`.
 *
 * Rows are built field by field, never by spreading the record, so a GM-only
 * field can only reach a non-GM template by being added here on purpose.
 */

const TONES = new Set(["success", "failure", "neutral"]);

/** The name a viewer may see for `combatant` -- PF2e's own token name
 * visibility (the metagame setting + TokenDocument#playersCanSeeName) is
 * respected for players, the same rule #925's chat card uses. */
export function logCombatantLabel(combatant, { isGM, hideNames }) {
  if (!combatant) return null;
  if (!isGM && hideNames && combatant.token?.playersCanSeeName === false) return "Unknown creature";
  return combatant.token?.name ?? combatant.name ?? null;
}

function toRound(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Fields of a record every viewer may see. */
const PUBLIC_FIELDS = [
  "combatantId",
  "tokenId",
  "round",
  "turn",
  "index",
  "type",
  "kind",
  "cost",
  "summary",
  "target",
  "result",
  "visibility",
];

/**
 * #951: the one shared definition of "what this viewer may see" of an
 * agentLog -- used by buildAiLogView (the #950 window) and by #951's
 * buildCombatantDigest (Combat Tracker row, token hover), so those surfaces
 * can never disagree about it. Anything that isn't an array reads as empty
 * and non-object entries are dropped. A GM gets the records unchanged; a
 * non-GM loses every `visibility: "gm"` record (a hidden token's actions)
 * and gets copies of the rest carrying the public fields only -- never the
 * rationale, the GM note, the fallback/model source or the candidate id.
 * Array order (append order, i.e. chronological) is kept.
 */
export function visibleRecords(records, isGM) {
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r === "object") : [];
  if (isGM === true) return list;
  return list
    .filter((r) => r.visibility !== "gm")
    .map((r) => {
      const out = {};
      for (const key of PUBLIC_FIELDS) if (Object.hasOwn(r, key)) out[key] = r[key];
      return out;
    });
}

/**
 * `records` the combat's agentLog (anything that isn't an array reads as
 * empty); `combatantInfo` `{[combatantId]: {name, img}}`; the filters
 * `combatantId`/`round` (null/"" = all; a value absent from the visible log
 * also means all, so a stale filter never silently empties the list).
 * Returns `{rows, combatants, rounds, roundOptions, selectedCombatantId,
 * selectedRound}`; the option lists are built from the rows this viewer may
 * see, so a player's filters never name a hidden actor.
 */
export function buildAiLogView(records, combatantInfo, { combatantId = null, round = null, isGM = false } = {}) {
  const visible = visibleRecords(records, isGM);
  const info = (id) => combatantInfo?.[id] ?? null;

  const combatantIds = [...new Set(visible.map((r) => r.combatantId))];
  const rounds = [...new Set(visible.map((r) => toRound(r.round)).filter((n) => n !== null))].sort((a, b) => a - b);

  const selectedCombatantId = combatantId && combatantIds.includes(combatantId) ? combatantId : null;
  const wantedRound = toRound(round);
  const selectedRound = wantedRound !== null && rounds.includes(wantedRound) ? wantedRound : null;

  const rows = visible
    .filter(
      (r) =>
        (selectedCombatantId === null || r.combatantId === selectedCombatantId) &&
        (selectedRound === null || toRound(r.round) === selectedRound),
    )
    .map((r) => ({
      combatantId: r.combatantId ?? null,
      combatantName: info(r.combatantId)?.name ?? "Unknown",
      img: info(r.combatantId)?.img ?? null,
      tokenId: r.tokenId ?? null,
      round: toRound(r.round),
      turn: Number.isInteger(r.turn) ? r.turn : null,
      cost: Number.isInteger(r.cost) && r.cost >= 1 && r.cost <= 3 ? r.cost : null,
      summary: typeof r.summary === "string" && r.summary ? r.summary : "Action",
      targetName: r.target?.name ?? null,
      resultText: r.result?.text ?? "done",
      tone: TONES.has(r.result?.tone) ? r.result.tone : "neutral",
      rationale: isGM ? (r.rationale || null) : null,
      gmNote: isGM ? (r.gmNote || null) : null,
      fallback: isGM && r.source === "fallback",
      gmOnly: isGM && r.visibility === "gm",
    }));

  return {
    rows,
    combatants: combatantIds.map((id) => ({
      id,
      name: info(id)?.name ?? "Unknown",
      ...(id === selectedCombatantId ? { selected: true } : {}),
    })),
    rounds,
    roundOptions: rounds.map((value) => ({ value, selected: value === selectedRound })),
    selectedCombatantId,
    selectedRound,
  };
}
