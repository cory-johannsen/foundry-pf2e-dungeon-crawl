import { describe, it, expect } from "vitest";
import {
  buildDecisionAlternatives,
  buildDecisionDetails,
  renderDecisionDetailsHtml,
  DECISION_ALTERNATIVES_CAP,
} from "../scripts/ui/ai-decision-details.mjs";

// #952: GM-only alternatives considered and decision metadata.

const cand = (i, over = {}) => ({ id: `c${i}`, type: "strike", summary: `Option ${i}`, ...over });

describe("buildDecisionAlternatives (#952)", () => {
  it("lists every candidate in offered order with the chosen one marked", () => {
    const { alternatives, moreCount } = buildDecisionAlternatives([cand(0), cand(1), cand(2)], "c1");
    expect(alternatives).toEqual([
      { id: "c0", summary: "Option 0", chosen: false },
      { id: "c1", summary: "Option 1", chosen: true },
      { id: "c2", summary: "Option 2", chosen: false },
    ]);
    expect(moreCount).toBe(0);
  });

  it("keeps exactly 12 without a moreCount when 12 were offered", () => {
    const list = Array.from({ length: 12 }, (_, i) => cand(i));
    const { alternatives, moreCount } = buildDecisionAlternatives(list, "c11");
    expect(DECISION_ALTERNATIVES_CAP).toBe(12);
    expect(alternatives).toHaveLength(12);
    expect(alternatives[11]).toMatchObject({ id: "c11", chosen: true });
    expect(moreCount).toBe(0);
  });

  it("caps at 12 and keeps the chosen candidate (first) even when it was offered past the cap", () => {
    const list = Array.from({ length: 20 }, (_, i) => cand(i));
    const { alternatives, moreCount } = buildDecisionAlternatives(list, "c17");
    expect(alternatives).toHaveLength(12);
    expect(alternatives[0]).toEqual({ id: "c17", summary: "Option 17", chosen: true });
    expect(alternatives.slice(1).map((a) => a.id)).toEqual(Array.from({ length: 11 }, (_, i) => `c${i}`));
    expect(alternatives.filter((a) => a.chosen)).toHaveLength(1);
    expect(moreCount).toBe(8);
  });

  it("caps an over-long list whose chosen id isn't in it (an external pick) at 12, none marked", () => {
    const list = Array.from({ length: 15 }, (_, i) => cand(i));
    const { alternatives, moreCount } = buildDecisionAlternatives(list, "zzz");
    expect(alternatives).toHaveLength(12);
    expect(alternatives.some((a) => a.chosen)).toBe(false);
    expect(moreCount).toBe(3);
  });

  it("falls back to the type for a missing summary and truncates very long ones", () => {
    const { alternatives } = buildDecisionAlternatives(
      [{ id: "a", type: "seek" }, { id: "b", type: "strike", summary: "x".repeat(300) }],
      "a",
    );
    expect(alternatives[0].summary).toBe("seek");
    expect(alternatives[1].summary.length).toBeLessThanOrEqual(100);
  });

  it("yields no alternatives (never throws) for a non-list", () => {
    expect(buildDecisionAlternatives(undefined, "a")).toEqual({ alternatives: [], moreCount: 0 });
    expect(buildDecisionAlternatives([null, 3], "a")).toEqual({ alternatives: [], moreCount: 0 });
  });
});

const record = {
  alternatives: [
    { id: "a", summary: "Strike Goblin", chosen: true },
    { id: "b", summary: "Strike Fighter", chosen: false },
  ],
  moreCount: 3,
  meta: {
    provider: "litellm",
    model: "openrouter/nvidia/nemotron-3.5-lightning:free",
    tier: "reasoning",
    clientMs: 2310,
    serverMs: 2140,
    usage: { promptTokens: 1830, completionTokens: 64, totalTokens: 1894 },
    costUsd: 0.0112,
  },
  fallbackReason: null,
};

describe("buildDecisionDetails (#952)", () => {
  it("returns strictly null for a non-GM user, whatever the record carries", () => {
    expect(buildDecisionDetails(record, { isGM: false })).toBeNull();
    expect(buildDecisionDetails(record, {})).toBeNull();
    expect(buildDecisionDetails(record)).toBeNull();
  });

  it("returns null when there is nothing to show", () => {
    expect(buildDecisionDetails({}, { isGM: true })).toBeNull();
    expect(buildDecisionDetails({ alternatives: [], meta: {} }, { isGM: true })).toBeNull();
    expect(buildDecisionDetails(null, { isGM: true })).toBeNull();
  });

  it("builds alternatives, moreCount and formatted lines for a GM", () => {
    const details = buildDecisionDetails(record, { isGM: true });
    expect(details.alternatives).toEqual([
      { summary: "Strike Goblin", chosen: true },
      { summary: "Strike Fighter", chosen: false },
    ]);
    expect(details.moreCount).toBe(3);
    expect(details.lines).toEqual([
      "Provider: litellm · Model: openrouter/nvidia/nemotron-3.5-lightning:free (reasoning tier)",
      "Latency: 2.3 s (server 2.1 s)",
      "Tokens: 1,894 (≈ $0.011)",
    ]);
  });

  it("names the model once when it is the tier alias itself", () => {
    const details = buildDecisionDetails({ meta: { provider: "litellm", model: "fast", tier: "fast" } }, { isGM: true });
    expect(details.lines).toEqual(["Provider: litellm · Model: fast"]);
  });

  it("omits a line for every absent field rather than printing undefined", () => {
    const details = buildDecisionDetails({ meta: { provider: "laya", serverMs: 50 } }, { isGM: true });
    expect(details.lines).toEqual(["Provider: laya", "Latency: server 0.1 s"]);
    expect(details.lines.join(" ")).not.toContain("undefined");
    expect(details.alternatives).toEqual([]);
  });

  it("formats a zero cost, a tiny cost and a cost without token counts", () => {
    expect(buildDecisionDetails({ meta: { usage: { totalTokens: 113 }, costUsd: 0 } }, { isGM: true }).lines).toEqual(["Tokens: 113 ($0)"]);
    expect(buildDecisionDetails({ meta: { usage: { totalTokens: 12 }, costUsd: 0.0004 } }, { isGM: true }).lines).toEqual(["Tokens: 12 (≈ $0.00040)"]);
    expect(buildDecisionDetails({ meta: { costUsd: 0.25 } }, { isGM: true }).lines).toEqual(["Cost: ≈ $0.250"]);
  });

  it("ignores malformed meta values instead of throwing", () => {
    const details = buildDecisionDetails(
      { alternatives: [{ id: "a", summary: "A", chosen: true }], meta: { clientMs: "slow", usage: "lots", costUsd: NaN, provider: 7 } },
      { isGM: true },
    );
    expect(details.lines).toEqual([]);
    expect(buildDecisionDetails({ meta: "nonsense" }, { isGM: true })).toBeNull();
  });

  it("words each fallback reason", () => {
    const lines = (fallbackReason, meta = { provider: "heuristic" }) => buildDecisionDetails({ fallbackReason, meta }, { isGM: true }).lines;
    expect(lines("timeout", { provider: "heuristic", timeoutMs: 45000 })).toEqual(["Provider: heuristic", "Fallback: timed out after 45 s"]);
    expect(lines("timeout")).toContain("Fallback: timed out");
    expect(lines("error")).toContain("Fallback: the decision call failed");
    expect(lines("apply-error")).toContain("Fallback: applying the decision failed");
    expect(lines("unconfigured")).toContain("Fallback: no agent service configured");
  });

  it("truncates a very long stored alternative summary for display", () => {
    const details = buildDecisionDetails({ alternatives: [{ id: "a", summary: "x".repeat(200), chosen: true }] }, { isGM: true });
    expect(details.alternatives[0].summary.length).toBeLessThanOrEqual(100);
  });
});

describe("renderDecisionDetailsHtml (#952)", () => {
  it("renders nothing for null (a non-GM's details)", () => {
    expect(renderDecisionDetailsHtml(null)).toBe("");
    expect(renderDecisionDetailsHtml(buildDecisionDetails(record, { isGM: false }))).toBe("");
  });

  it("renders a collapsed disclosure with the chosen alternative marked, +N more, and the lines", () => {
    const html = renderDecisionDetailsHtml(buildDecisionDetails(record, { isGM: true }));
    expect(html.startsWith('<details class="pf2edc-ai-details"><summary>Details</summary>')).toBe(true);
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>=]/);
    expect(html).toContain('<li class="pf2edc-ai-alternative pf2edc-ai-alternative-chosen"><strong>Strike Goblin</strong> (chosen)</li>');
    expect(html).toContain('<li class="pf2edc-ai-alternative">Strike Fighter</li>');
    expect(html).toContain("+3 more");
    expect(html).toContain("<div>Latency: 2.3 s (server 2.1 s)</div>");
    expect(html).not.toContain("data-visibility");
  });

  it("marks the disclosure GM-only for a public chat card", () => {
    const html = renderDecisionDetailsHtml(buildDecisionDetails(record, { isGM: true }), { gmVisibility: true });
    expect(html.startsWith('<details class="pf2edc-ai-details" data-visibility="gm">')).toBe(true);
  });

  it("escapes hostile summaries and metadata", () => {
    const html = renderDecisionDetailsHtml(
      buildDecisionDetails({ alternatives: [{ id: "a", summary: "<script>x", chosen: true }], meta: { provider: "<img>" } }, { isGM: true }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img>");
    expect(html).toContain("&lt;script&gt;x");
  });
});
