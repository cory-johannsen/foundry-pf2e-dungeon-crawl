import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { classifyTargetEffect, resolveTargetedSelfEffectConfig } from "../scripts/targeted-feat-actions.mjs";
import { parseFeatRequirements } from "../scripts/marked-target-requirements.mjs";
import { SELF_EFFECT_DENYLIST } from "../scripts/self-effect-denylist.mjs";

// #946: the real-population ratchet. tests/fixtures/marked-target-population.json
// is every one-action/free item with a selfEffect in the pf2e 8.5.0
// compendia (feats, actions, class-features) whose linked effect carries a
// TokenMark or a target:/@target reference -- the 21 items #914's old
// blanket rule excluded. Each one's route is re-derived live from the
// fixture's own data and pinned here, so a compendium change (or a change
// to the classifier/parser) is visible, and #990-#992/#1046 progress shows
// up as entries moving to an offered route.
const POPULATION = JSON.parse(
  readFileSync(new URL("./fixtures/marked-target-population.json", import.meta.url), "utf8"),
).entries;

/** route: "targeted" (targetedSelfEffect kind), "selfEffect" (plain #914
 * kind, still gated live by its Requirements), or "excluded" + reason. */
const EXPECTED = {
  "hunt-prey": ["marked", "targeted"],
  "devise-a-stratagem": ["unsupported", "targeted"], // #922's explicit config pre-selects its toggle
  smite: ["marked", "targeted"],
  "duelists-challenge": ["marked", "targeted"],
  "size-up": ["marked", "targeted"],
  "harsh-judgement": ["unsupported", "excluded", "toggleable RollOption (#1046)"],
  "nothing-personal": ["unsupported", "excluded", "toggleable RollOption (#1046); planned course of action (#992)"],
  "whispers-of-weakness": ["marked", "excluded", "cursebound; per-target 1-day immunity untracked"],
  "hungry-blade": ["marked", "excluded", "previous-Strike damage-type requirement (#992)"],
  "enforce-oath": ["marked", "excluded", "sworn-oath requirement (#992)"],
  "harvest-blood": ["marked", "excluded", "last-action Strike requirement (#992)"],
  "hunt-the-razers-pawn": ["marked", "excluded", "agent-of-Treerazer judgment (#992)"],
  "unfazed-assessment": ["unsupported", "excluded", "ChoiceSet (#991)"],
  "come-and-get-me": ["unsupported", "excluded", "GrantItem (#991)"],
  "divine-weapon": ["unsupported", "excluded", "ChoiceSet (#991)"],
  "hunt-runelord": ["unsupported", "excluded", "ChoiceSet (#991)"],
  "intensified-element-stance": ["unsupported", "excluded", "ChoiceSet (#991)"],
  "point-blank-stance": ["targetConditional", "selfEffect"],
  "spell-parry": ["targetConditional", "selfEffect"],
  "monastic-archer-stance": ["targetConditional", "excluded", "'unarmored' requirement outside the closed set"],
  "eye-of-the-arclords": ["targetConditional", "excluded", "denylisted: afterwards-dazzled drawback not in its effect"],
};

function routeOf(entry) {
  const classification = classifyTargetEffect(entry.effect.rules);
  const item = { slug: entry.slug, system: { traits: { value: entry.traits }, description: { value: entry.description } } };
  if (resolveTargetedSelfEffectConfig(item, { system: { rules: entry.effect.rules } })) return [classification, "targeted"];
  if (classification === "targetConditional" && !SELF_EFFECT_DENYLIST.has(entry.slug) && parseFeatRequirements(entry.description)) {
    return [classification, "selfEffect"];
  }
  return [classification, "excluded"];
}

describe("#946 marked-target population audit (pf2e 8.5.0)", () => {
  it("covers exactly the 21 items #914's old target-dependent rule excluded", () => {
    expect(POPULATION.map((e) => e.slug).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("classification counts: 9 marked, 8 unsupported, 4 target-conditional", () => {
    const counts = {};
    for (const e of POPULATION) {
      const c = classifyTargetEffect(e.effect.rules);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    expect(counts).toEqual({ marked: 9, unsupported: 8, targetConditional: 4 });
  });

  it("each item's live-derived route matches the pinned audit", () => {
    for (const entry of POPULATION) {
      const [classification, route] = EXPECTED[entry.slug];
      expect(routeOf(entry), entry.slug).toEqual([classification, route]);
    }
  });

  it("offers 5 as targeted marks and 2 as plain self-effects; every excluded item names its reason", () => {
    const routes = Object.values(EXPECTED);
    expect(routes.filter((r) => r[1] === "targeted")).toHaveLength(5);
    expect(routes.filter((r) => r[1] === "selfEffect")).toHaveLength(2);
    for (const r of routes.filter((x) => x[1] === "excluded")) expect(r[2]).toBeTruthy();
  });
});
