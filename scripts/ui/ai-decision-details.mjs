/**
 * #952: the GM-only "Details" of an AI action -- the other candidates
 * offered that turn (the chosen one marked) and how the decision was made
 * (provider, model/tier, latency, token usage/cost, why the heuristic
 * fallback fired). Pure, no Foundry API surface: dungeon-combat.mjs stores
 * `buildDecisionAlternatives`'s output and the decision `meta` on #925's
 * agentLog record; #925's chat card, #950's log window and #951's tracker
 * row all render it through `buildDecisionDetails` +
 * `renderDecisionDetailsHtml`, so the three can never disagree.
 *
 * GM-only by construction: `buildDecisionDetails` returns null for a
 * non-GM, and #950's `visibleRecords` never copies the
 * alternatives/meta/fallbackReason fields into a non-GM's records in the
 * first place. Client-side hiding only, as for the rationale (#925).
 *
 * Deliberately imports nothing (its own tiny escape) so
 * agent-action-display.mjs, ai-action-digest.mjs and ai-action-log-view.mjs
 * can all import it without a cycle.
 */

export const DECISION_ALTERNATIVES_CAP = 12;
const SUMMARY_MAX = 100;

const FALLBACK_LABELS = Object.freeze({
  timeout: "timed out",
  error: "the decision call failed",
  "apply-error": "applying the decision failed",
  unconfigured: "no agent service configured",
});

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text, max = SUMMARY_MAX) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * The alternatives stored on a record: every candidate offered for this
 * decision as `{id, summary, chosen}` (summary falls back to the candidate
 * type, truncated), in offered order. Over `cap`, the chosen candidate is
 * moved to the front so truncation can never drop it, the rest keep their
 * order, and `moreCount` says how many were cut. Never throws; anything
 * that isn't a candidate list yields no alternatives.
 */
export function buildDecisionAlternatives(candidates, chosenId, { cap = DECISION_ALTERNATIVES_CAP } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && typeof c === "object") : [];
  const toEntry = (c) => ({
    id: c.id ?? null,
    summary: truncate(c.summary || c.type || c.id || "Action"),
    chosen: c.id === chosenId,
  });
  if (list.length <= cap) return { alternatives: list.map(toEntry), moreCount: 0 };
  const chosen = list.find((c) => c.id === chosenId);
  const rest = list.filter((c) => c !== chosen);
  const kept = chosen ? [chosen, ...rest.slice(0, cap - 1)] : rest.slice(0, cap);
  return { alternatives: kept.map(toEntry), moreCount: list.length - kept.length };
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

function costText(costUsd) {
  if (costUsd === 0) return "$0";
  if (Math.abs(costUsd) < 0.001) return `≈ $${costUsd.toPrecision(2)}`;
  return `≈ $${costUsd.toFixed(3)}`;
}

/** The metadata lines, one per field present -- an absent field adds no
 * line (never "undefined"). */
function metadataLines(record) {
  const meta = record?.meta && typeof record.meta === "object" && !Array.isArray(record.meta) ? record.meta : {};
  const lines = [];
  const provider = typeof meta.provider === "string" && meta.provider ? meta.provider : null;
  const model = typeof meta.model === "string" && meta.model ? meta.model : null;
  const tier = typeof meta.tier === "string" && meta.tier ? meta.tier : null;
  const parts = [];
  if (provider) parts.push(`Provider: ${provider}`);
  if (model) parts.push(`Model: ${model}${tier && tier !== model ? ` (${tier} tier)` : ""}`);
  else if (tier) parts.push(`Tier: ${tier}`);
  if (parts.length) lines.push(parts.join(" · "));

  const clientMs = isFiniteNumber(meta.clientMs) ? meta.clientMs : null;
  const serverMs = isFiniteNumber(meta.serverMs) ? meta.serverMs : null;
  if (clientMs !== null && serverMs !== null) lines.push(`Latency: ${seconds(clientMs)} (server ${seconds(serverMs)})`);
  else if (clientMs !== null) lines.push(`Latency: ${seconds(clientMs)}`);
  else if (serverMs !== null) lines.push(`Latency: server ${seconds(serverMs)}`);

  const total = isFiniteNumber(meta.usage?.totalTokens) ? meta.usage.totalTokens : null;
  const cost = isFiniteNumber(meta.costUsd) ? meta.costUsd : null;
  if (total !== null) {
    const tokens = total.toLocaleString("en-US");
    lines.push(cost !== null ? `Tokens: ${tokens} (${costText(cost)})` : `Tokens: ${tokens}`);
  } else if (cost !== null) {
    lines.push(`Cost: ${costText(cost)}`);
  }

  const reason = typeof record?.fallbackReason === "string" && record.fallbackReason ? record.fallbackReason : null;
  if (reason) {
    let label = FALLBACK_LABELS[reason] ?? reason;
    if (reason === "timeout" && isFiniteNumber(meta.timeoutMs)) label = `timed out after ${Math.round(meta.timeoutMs / 1000)} s`;
    lines.push(`Fallback: ${label}`);
  }
  return lines;
}

/**
 * `record` an agentLog record; returns null for a non-GM (strictly null, so
 * a template that forgets the check renders nothing rather than an empty
 * disclosure) or when the record has nothing to show; otherwise
 * `{alternatives: [{summary, chosen}], moreCount, lines}`.
 */
export function buildDecisionDetails(record, { isGM } = {}) {
  if (isGM !== true) return null;
  if (!record || typeof record !== "object") return null;
  const alternatives = Array.isArray(record.alternatives)
    ? record.alternatives
        .filter((a) => a && typeof a === "object")
        .map((a) => ({ summary: truncate(a.summary || a.id || "Action"), chosen: a.chosen === true }))
    : [];
  const lines = metadataLines(record);
  if (!alternatives.length && !lines.length) return null;
  const moreCount = Number.isInteger(record.moreCount) && record.moreCount > 0 ? record.moreCount : 0;
  return { alternatives, moreCount, lines };
}

/**
 * The collapsed `<details>` disclosure for `details` (buildDecisionDetails'
 * output), or "" for null. Every string is escaped (candidate summaries
 * carry creature names; model names come from an external service).
 * `gmVisibility` adds `data-visibility="gm"` so PF2e's chat renderer
 * (UserVisibilityPF2e.process, pf2e 8.5.0: any `[data-visibility=gm]`
 * element is removed for non-GM users) strips it from a public chat card.
 */
export function renderDecisionDetailsHtml(details, { gmVisibility = false } = {}) {
  if (!details) return "";
  const alternatives = details.alternatives.length
    ? `<ul class="pf2edc-ai-alternatives">` +
      details.alternatives
        .map((a) =>
          a.chosen
            ? `<li class="pf2edc-ai-alternative pf2edc-ai-alternative-chosen"><strong>${escapeHtml(a.summary)}</strong> (chosen)</li>`
            : `<li class="pf2edc-ai-alternative">${escapeHtml(a.summary)}</li>`,
        )
        .join("") +
      (details.moreCount > 0 ? `<li class="pf2edc-ai-alternative-more">+${details.moreCount} more</li>` : "") +
      `</ul>`
    : "";
  const lines = details.lines.length
    ? `<div class="pf2edc-ai-decision-meta">${details.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>`
    : "";
  const heading = details.alternatives.length ? `<div class="pf2edc-ai-alternatives-label">Alternatives considered</div>` : "";
  return (
    `<details class="pf2edc-ai-details"${gmVisibility ? ` data-visibility="gm"` : ""}>` +
    `<summary>Details</summary>${heading}${alternatives}${lines}</details>`
  );
}
