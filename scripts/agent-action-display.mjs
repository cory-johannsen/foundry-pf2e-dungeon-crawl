/**
 * #925: pure display helpers for the consolidated per-turn AI action card.
 * No Foundry API surface: dungeon-combat.mjs captures each executor's own
 * return value, passes it here to be described, appends the result to the
 * combat's `agentLog`, and renders the card HTML with
 * `renderAgentTurnCardHtml`.
 *
 * Public vs GM-only: everything a record's `summary`/`targetName`/`result`
 * says is shown to the whole table. Anything GM-only (the model's rationale,
 * DCs, d20 values, "apply by hand" instructions, a stalled stride's cause)
 * goes in `gmNote`/`rationale`, which the card wraps in
 * `data-visibility="gm"` -- PF2e's TextEditorPF2e.enrichHTML (which core
 * ChatMessage#renderHTML runs the content through) removes those elements
 * for every non-GM client (UserVisibilityPF2e.process, pf2e 8.5.0).
 *
 * The public summary is the action's own name only (never the candidate's
 * full `summary`, which can carry the reasoning model's pick rationale, a
 * MAP variant index, or a Devise a Stratagem d20 value).
 */

import { MANEUVER_DEFS } from "./agent-candidates.mjs";

const NEUTRAL_DONE = Object.freeze({ text: "done", tone: "neutral" });

/** The acting creature's own attack roll (Strike, spell attack). */
const ATTACK_RESULT = Object.freeze({
  criticalSuccess: { text: "critical hit", tone: "success" },
  success: { text: "hit", tone: "success" },
  failure: { text: "miss", tone: "failure" },
  criticalFailure: { text: "critical miss", tone: "failure" },
});

/** A target's saving throw against the acting creature -- the target
 * succeeding is a failure from the actor's side, hence the inverted tone. */
const SAVE_RESULT = Object.freeze({
  criticalSuccess: { text: "saved (critical)", tone: "failure" },
  success: { text: "saved", tone: "failure" },
  failure: { text: "failed save", tone: "success" },
  criticalFailure: { text: "failed save (critical)", tone: "success" },
});

/** The acting creature's own skill check (a maneuver). */
const CHECK_RESULT = Object.freeze({
  criticalSuccess: { text: "critical success", tone: "success" },
  success: { text: "success", tone: "success" },
  failure: { text: "failure", tone: "failure" },
  criticalFailure: { text: "critical failure", tone: "failure" },
});

const STRIDE_RESULT = Object.freeze({
  moved: { text: "moved", tone: "neutral" },
  blocked: {
    text: "blocked",
    tone: "failure",
    gmNote: "A route exists, but every reachable square is occupied.",
  },
  "no-route": { text: "no route", tone: "neutral" },
  "no-speed": { text: "could not move", tone: "neutral" },
  // #931: a Twisting Tail hit / Wing Rebuff push stopped the move part-way.
  disrupted: {
    text: "move disrupted",
    tone: "failure",
    gmNote: "A reaction disrupted the move action; the creature stopped where the reaction hit it.",
  },
});

/** #932: a movement ability's movement part (executeNpcMoveCandidate's
 * `moveStatus`). */
const NPC_MOVE_STATUS = Object.freeze({
  moved: { text: "moved", tone: "neutral" },
  stayed: { text: "stayed", tone: "neutral" },
  teleported: { text: "teleported", tone: "neutral" },
  disrupted: { text: "move disrupted", tone: "failure" },
});

/** Every candidate type whose executor returns the target's save outcomes
 * as `[{targetId, outcome}]` (castAutoHitAreaTier's no-save tier returns
 * `{targetId, total}` instead; castDualArea/castTargetCount mix in
 * `{targetId, healed}` heal entries). */
const PER_TARGET_TYPES = new Set([
  "castArea",
  "castAreaTier",
  "castAutoHitAreaTier",
  "breathWeapon",
  "castChain",
  "castDualArea",
  "castTargetCount",
  "npcAbility",
]);

/** Single-target types whose executor returns the target's save outcome. */
const SINGLE_SAVE_TYPES = new Set(["cast", "castDebuff", "castDualHarm"]);

/** Single-target types whose executor returns the actor's attack outcome. */
const SINGLE_ATTACK_TYPES = new Set(["strike", "castAttack"]);

/** Escapes text for HTML. Always applied to every string in the card --
 * candidate summaries carry creature names and rationale is free text from
 * an external model. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The action's own name for the public card -- see the file comment. */
export function publicActionLabel(candidate) {
  const type = candidate?.type;
  const summary = String(candidate?.summary ?? "");
  if (type === "endTurn") return "End turn";
  if (type === "seek") return "Seek";
  if (type === "stride") {
    if (candidate.posture === "approach") return "Move toward";
    if (candidate.posture === "retreat") return "Move away from";
    if (candidate.posture === "reposition") return "Move away from a hazard";
    return "Move";
  }
  if (type === "maneuver") return MANEUVER_DEFS[candidate.slug]?.label ?? candidate.slug ?? "Maneuver";
  if (type === "feat" || type === "npcAbility" || type === "npcMove") return candidate.name ?? candidate.slug ?? type;
  // Every other builder in agent-candidates.mjs leads its summary with the
  // action/spell label, followed by one of these separators.
  const cut = summary.search(/ vs | \(hits | on | heals | \(variant | \(\d+ actions?\)| — | \[/);
  const label = (cut >= 0 ? summary.slice(0, cut) : summary).trim();
  return label || type || "Action";
}

function aggregateTone(results) {
  if (!results.length) return "neutral";
  if (results.every((r) => r.tone === "success")) return "success";
  if (results.every((r) => r.tone === "failure")) return "failure";
  return "neutral";
}

/** One per-target entry from a multi-target executor -> `{text, tone}`. */
function describeTargetEntry(entry, nameOf) {
  const name = nameOf(entry?.targetId) ?? "a creature";
  const save = SAVE_RESULT[entry?.outcome];
  if (save) {
    // npcAbility entries also say what the degree applied.
    const applied = typeof entry.applied === "string" && entry.applied ? ` -- ${entry.applied}` : "";
    return { text: `${name}: ${save.text}${applied}`, tone: save.tone };
  }
  if (typeof entry?.text === "string" && entry.text) {
    return { text: `${name}: ${entry.text}`, tone: entry.tone ?? "neutral" };
  }
  if ((entry && Object.hasOwn(entry, "healed")) || entry?.effect === "heal") {
    return typeof entry.healed === "number"
      ? { text: `${name}: healed ${entry.healed}`, tone: "success" }
      : { text: `${name}: no healing`, tone: "neutral" };
  }
  if (typeof entry?.total === "number") {
    return { text: `${name}: ${entry.total} damage`, tone: "success" };
  }
  return { text: `${name}: no result`, tone: "neutral" };
}

function describePerTarget(entries, nameOf) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const parts = entries.map((e) => describeTargetEntry(e, nameOf));
  return { text: parts.map((p) => p.text).join("; "), tone: aggregateTone(parts) };
}

function describeAttackList(outcomes) {
  const parts = outcomes.map((o) => ATTACK_RESULT[o] ?? { text: "no result", tone: "neutral" });
  if (!parts.length) return null;
  return { text: parts.map((p) => p.text).join(", "), tone: aggregateTone(parts) };
}

function resultFor(candidate, executionResult, nameOf) {
  const type = candidate?.type;
  const r = executionResult;
  if (type === "endTurn") return { text: "ends turn", tone: "neutral" };
  if (SINGLE_ATTACK_TYPES.has(type)) {
    if (r && typeof r === "object" && typeof r.skipped === "string") {
      return { text: `not made (${r.skipped})`, tone: "neutral" };
    }
    return ATTACK_RESULT[r] ?? null;
  }
  if (SINGLE_SAVE_TYPES.has(type)) return SAVE_RESULT[r] ?? null;
  if (type === "multiStrike") {
    return Array.isArray(r) ? describeAttackList(r.map((s) => s?.outcome)) : null;
  }
  if (PER_TARGET_TYPES.has(type)) {
    // npcAbility's executor returns {performed, results, gmNote}.
    const entries = type === "npcAbility" ? r?.results : r;
    return describePerTarget(entries, nameOf);
  }
  if (type === "castHeal" || type === "castDualHeal") {
    if (typeof r === "number") return { text: `healed ${r}`, tone: "success" };
    return r === null ? { text: "no healing", tone: "neutral" } : null;
  }
  if (type === "castBuff") {
    if (typeof r === "string" && r) return { text: `gained ${r}`, tone: "success" };
    return r === null ? { text: "no effect", tone: "neutral" } : null;
  }
  if (type === "stride") {
    const stride = STRIDE_RESULT[r];
    return stride ? { text: stride.text, tone: stride.tone } : null;
  }
  if (type === "seek") {
    if (!Array.isArray(r)) return { text: "sought", tone: "neutral" };
    const found = r.filter((s) => s && s.to !== s.from).length;
    return found
      ? { text: `${found} detection change${found === 1 ? "" : "s"}`, tone: "success" }
      : { text: "found nothing new", tone: "neutral" };
  }
  if (type === "maneuver") {
    if (!r || typeof r !== "object") return null;
    const check = CHECK_RESULT[r.outcome];
    if (!check) return { text: r.text || "no check result", tone: "neutral" };
    return { text: r.text ? `${check.text}: ${r.text}` : check.text, tone: check.tone };
  }
  if (type === "npcMove") {
    if (!r || typeof r !== "object") return null;
    const move = NPC_MOVE_STATUS[r.moveStatus] ?? { text: "moved", tone: "neutral" };
    const strikes = Array.isArray(r.strikeOutcomes) && r.strikeOutcomes.length ? describeAttackList(r.strikeOutcomes) : null;
    if (strikes) return { text: `${move.text}; ${strikes.text}`, tone: strikes.tone };
    if (typeof r.strikeSkipped === "string" && r.strikeSkipped) {
      return { text: `${move.text}; no Strike (${r.strikeSkipped})`, tone: move.tone === "failure" ? "failure" : "neutral" };
    }
    return { text: move.text, tone: move.tone };
  }
  if (type === "feat") {
    if (!r || typeof r !== "object") return null;
    if (typeof r.text === "string" && r.text) return { text: r.text, tone: r.tone ?? "success" };
    if (Array.isArray(r.strikeOutcomes) && r.strikeOutcomes.length) return describeAttackList(r.strikeOutcomes);
    if (typeof r.effectName === "string" && r.effectName) return { text: `gained ${r.effectName}`, tone: "success" };
    if (Array.isArray(r.strikeOutcomes)) return { text: "no Strike made", tone: "neutral" };
    return null;
  }
  return null;
}

/** The GM-only note an executor attached to its own result, if any. */
function gmNoteFor(candidate, executionResult) {
  if (candidate?.type === "stride") return STRIDE_RESULT[executionResult]?.gmNote ?? null;
  const note = executionResult && typeof executionResult === "object" ? executionResult.gmNote : null;
  return typeof note === "string" && note ? note : null;
}

/** Single-target candidate types name their target on the row itself;
 * multi-target ones name each target inside the result instead. */
function targetIdFor(candidate) {
  if (!candidate?.targetId) return null;
  if (PER_TARGET_TYPES.has(candidate.type) && candidate.type !== "npcAbility") return null;
  if (candidate.type === "npcAbility" && (candidate.affectedIds?.length ?? 0) > 1) return null;
  return candidate.targetId;
}

/**
 * Describes one executed candidate for the card and the log:
 * `{ summary, targetId, targetName, result: {text, tone}, gmNote }`.
 * `executionResult` is whatever that candidate type's executor returned
 * (see applyAgentDecision); `nameOf(combatantId)` resolves a display name.
 * Never throws -- unreadable executor output reads as a neutral "done".
 */
export function describeAgentAction(candidate, executionResult, { nameOf = () => null } = {}) {
  const safeNameOf = (id) => {
    if (!id) return null;
    try {
      return nameOf(id) ?? null;
    } catch {
      return null;
    }
  };
  let result = null;
  let gmNote = null;
  let summary = candidate?.type ?? "Action";
  try {
    summary = publicActionLabel(candidate);
    result = resultFor(candidate, executionResult, safeNameOf);
    gmNote = gmNoteFor(candidate, executionResult);
  } catch {
    result = null;
  }
  const targetId = targetIdFor(candidate);
  return {
    summary,
    targetId,
    targetName: targetId ? safeNameOf(targetId) : null,
    result: result ?? { ...NEUTRAL_DONE },
    gmNote,
  };
}

const TONES = new Set(["success", "failure", "neutral"]);

function costGlyph(cost) {
  if (!Number.isInteger(cost) || cost < 1 || cost > 3) return "";
  return `<span class="action-glyph">${cost}</span> `;
}

/**
 * The card's HTML for one (combatant, round): one row per record, in
 * `index` order. A record with `visibility: "gm"` (its token was hidden
 * from players when it acted) is a GM-only row; rationale, the executor's
 * GM note and the fallback tag are GM-only parts of a row, and absent
 * entirely (no empty element) when there's nothing to show.
 */
export function renderAgentTurnCardHtml({ round, records }) {
  const rows = [...(records ?? [])]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((r) => {
      const tone = TONES.has(r?.result?.tone) ? r.result.tone : "neutral";
      const target = r?.target?.name ? ` <span class="pf2edc-agent-target">→ ${escapeHtml(r.target.name)}</span>` : "";
      const fallback = r?.source === "fallback"
        ? ` <span data-visibility="gm" class="pf2edc-agent-fallback">(fallback heuristic)</span>`
        : "";
      const note = r?.gmNote
        ? `<div data-visibility="gm" class="pf2edc-agent-note">${escapeHtml(r.gmNote).replace(/\n/g, "<br>")}</div>`
        : "";
      const rationale = r?.rationale
        ? `<div data-visibility="gm" class="pf2edc-agent-rationale"><em>${escapeHtml(r.rationale)}</em></div>`
        : "";
      const rowVisibility = r?.visibility === "gm" ? ` data-visibility="gm"` : "";
      return (
        `<li class="pf2edc-agent-action"${rowVisibility}>` +
        `${costGlyph(r?.cost)}<strong>${escapeHtml(r?.summary ?? "Action")}</strong>${target} ` +
        `<span class="pf2edc-agent-result pf2edc-agent-result-${tone}">${escapeHtml(r?.result?.text ?? "done")}</span>` +
        `${fallback}${note}${rationale}</li>`
      );
    })
    .join("");
  const roundLabel = Number.isFinite(round) ? ` — Round ${round}` : "";
  return `<div class="pf2edc-agent-turn"><header class="pf2edc-agent-turn-header"><strong>AI turn</strong>${roundLabel}</header><ol class="pf2edc-agent-actions">${rows}</ol></div>`;
}
