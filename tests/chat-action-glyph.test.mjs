import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAgentTurnCardHtml } from "../scripts/agent-action-display.mjs";

// Mirrors pf2e-auto-action-tracker v0.19.1 GenericActionDetector.isType's content test.
const trackerWouldLog = (html) => html.includes('class="action-glyph"');
const hasSystemGlyphClass = (html) => /class="(?:[^"]*\s)?action-glyph(?:\s[^"]*)?"/.test(html);

const base = { summary: "Strike", result: { text: "hit", tone: "success" }, gmNote: null, rationale: null, source: "model", visibility: "all" };
const records = [
  { ...base, index: 0, cost: 1 },
  { ...base, index: 1, cost: 2, target: { id: "t1", name: "Goblin" } },
  { ...base, index: 2, cost: 3, visibility: "gm", rationale: "closest", gmNote: "DC 20" },
  { ...base, index: 3, cost: 0 },
  { ...base, index: 4, cost: 4 },
  { ...base, index: 5, cost: null, source: "fallback", visibility: "gm" },
  { ...base, index: 6, cost: "2" },
];

describe("#1252 AI turn card vs the action tracker", () => {
  const html = renderAgentTurnCardHtml({ round: 1, records, combatantId: "c1" });

  it("the card never matches the tracker's action-glyph detector", () => {
    expect(trackerWouldLog(html)).toBe(false);
    expect(hasSystemGlyphClass(html)).toBe(false);
  });

  it("valid costs 1..3 use the module glyph class, invalid costs render no glyph", () => {
    expect(html.match(/pf2edc-action-glyph/g)).toHaveLength(3);
    expect(html).toContain('<span class="pf2edc-action-glyph">1</span>');
    expect(html).toContain('<span class="pf2edc-action-glyph">3</span>');
  });

  it("detector predicate does fire on the system class (guard is meaningful)", () => {
    expect(trackerWouldLog('<span class="action-glyph">1</span>')).toBe(true);
  });
});

describe("#1252 no system glyph class in module scripts that can reach chat", () => {
  // Files that legitimately contain the literal, each with the reason.
  const ALLOW = {
    "ai-action-digest.mjs": "DOM-only digest rows (Combat Tracker row / tooltip), never chat",
    "agent-candidates.mjs": "regexes parsing compendium description HTML",
  };
  const dir = new URL("../scripts/", import.meta.url).pathname;
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".mjs") ? [join(d, e.name)] : [],
    );

  it("no non-allowlisted script contains the literal class=\"action-glyph\"", () => {
    const offenders = walk(dir)
      .filter((f) => readFileSync(f, "utf8").includes('class="action-glyph"'))
      .map((f) => f.slice(dir.length))
      .filter((rel) => !Object.keys(ALLOW).some((k) => rel === k || rel.endsWith(`/${k}`)));
    expect(offenders, `use a module-owned class in chat content (#1252); allowlist needs a reason`).toEqual([]);
  });

  it("no chat-posting script imports renderDigestRowHtml (DOM-only)", () => {
    const importers = walk(dir)
      .filter((f) => /import[^;]*renderDigestRowHtml/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(dir.length));
    expect(importers).toEqual(["ui/ai-action-detail.mjs"]);
  });
});
