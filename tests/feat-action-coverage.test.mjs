import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { explainTargetedFeat } from "../scripts/feat-action-shapes.mjs";
import { FEAT_ACTION_OVERRIDES } from "../scripts/feat-action-overrides.mjs";

// #947: the real-population ratchet. tests/fixtures/targeted-feat-action-audit.json
// is every action/free-action feat or action in the pf2e 8.5.0 compendia
// (feats, actions, class-features) with no selfEffect and one of the nine
// first-slice class traits, with each item's real description. Every entry
// is re-classified here from its own data, so a parser or compendium change
// shows up as a fixture diff, and coverage can't silently drop.
const AUDIT = JSON.parse(readFileSync(new URL("./fixtures/targeted-feat-action-audit.json", import.meta.url), "utf8"));

function asItem(entry) {
  return {
    type: entry.type,
    slug: entry.slug,
    name: entry.name,
    system: {
      actionType: { value: entry.actionType },
      actions: { value: entry.actions },
      traits: { value: entry.traits },
      frequency: entry.frequency,
      selfEffect: null,
      description: { value: entry.description },
    },
  };
}

/** The offered first slice -- raise (never lower) as shapes/overrides grow. */
const OFFERED = {
  "intimidating-strike": "strikePlus",
  "vicious-evisceration": "strikePlus",
  "resounding-blow": "strikePlus",
  "unbalancing-finisher": "strikePlus",
  "instant-opening": "targetEffect",
};
const MIN_OFFERED = Object.keys(OFFERED).length;

describe("#947 targeted feat action coverage audit (pf2e 8.5.0)", () => {
  it("re-derives every entry's committed classification and reason from its own text", () => {
    for (const entry of AUDIT.entries) {
      const { descriptor, reason } = explainTargetedFeat(asItem(entry));
      expect({ slug: entry.slug, shape: descriptor?.shape ?? "notOffered", reason }).toEqual({
        slug: entry.slug,
        shape: entry.expected,
        reason: entry.reason,
      });
    }
  });

  it("offers exactly the reviewed first slice", () => {
    const offered = Object.fromEntries(AUDIT.entries.filter((e) => e.expected !== "notOffered").map((e) => [e.slug, e.expected]));
    expect(offered).toEqual(OFFERED);
  });

  it("ratchet: coverage never drops below the committed count, and the summary counts match the entries", () => {
    const offeredCount = AUDIT.entries.filter((e) => e.expected !== "notOffered").length;
    expect(offeredCount).toBeGreaterThanOrEqual(MIN_OFFERED);
    const counts = {};
    for (const e of AUDIT.entries) counts[e.expected] = (counts[e.expected] ?? 0) + 1;
    expect(counts).toEqual(AUDIT.counts);
  });

  it("keeps the spec's named examples out for the reasons the investigation found", () => {
    const reasonOf = (slug) => AUDIT.entries.find((e) => e.slug === slug)?.reason;
    expect(reasonOf("felling-strike")).toBe("unmodeled rider text"); // flying state untracked
    expect(reasonOf("exploit-vulnerability")).toBe("has a frequency"); // also implement + narrative degrees
    expect(reasonOf("sabotage")).toBe("requirement outside the closed set"); // and item damage
    expect(reasonOf("leading-dance")).toBe("requirement outside the closed set"); // and forced movement
    expect(reasonOf("predictable")).toBe("no 'Choose a target within N feet.' sentence"); // ChoiceSet effect, one-use save bonus
  });

  it("every override entry names a real audited item", () => {
    const slugs = new Set(AUDIT.entries.map((e) => e.slug));
    for (const slug of FEAT_ACTION_OVERRIDES.keys()) expect(slugs.has(slug)).toBe(true);
  });
});
