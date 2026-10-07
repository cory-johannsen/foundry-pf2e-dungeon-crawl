import { describe, it, expect } from "vitest";
import { resolveChoiceSetsOnItemData, resolveChoiceSetsOnActorData } from "../scripts/choice-set.mjs";

// The real shape confirmed live this session against pf2e.equipment-srd's
// own "Charm of Resistance".
function itemWithChoiceSet(extra = {}) {
  return {
    name: "Charm of Resistance",
    system: {
      rules: [
        {
          key: "ChoiceSet",
          flag: "damageType",
          prompt: "PF2E.SpecificRule.Prompt.DamageType",
          choices: [
            { label: "PF2E.TraitAcid", value: "acid" },
            { label: "PF2E.TraitCold", value: "cold" },
            { label: "PF2E.TraitElectricity", value: "electricity" },
            { label: "PF2E.TraitFire", value: "fire" },
            { label: "PF2E.TraitSonic", value: "sonic" },
          ],
        },
      ],
    },
    flags: { pf2e: { rulesSelections: {}, ...extra } },
  };
}

describe("#897 resolveChoiceSetsOnItemData", () => {
  it("picks one of the rule's own listed choices and writes it to rulesSelections", () => {
    const resolved = resolveChoiceSetsOnItemData(itemWithChoiceSet(), () => 0);
    expect(resolved.flags.pf2e.rulesSelections.damageType).toBe("acid");
  });

  it("the picked value is always a member of the rule's own choices, across the full rng range", () => {
    const valid = new Set(["acid", "cold", "electricity", "fire", "sonic"]);
    for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.999]) {
      const resolved = resolveChoiceSetsOnItemData(itemWithChoiceSet(), () => r);
      expect(valid.has(resolved.flags.pf2e.rulesSelections.damageType)).toBe(true);
    }
  });

  it("never overwrites an already-resolved selection", () => {
    const resolved = resolveChoiceSetsOnItemData(
      itemWithChoiceSet({ rulesSelections: { damageType: "fire" } }),
      () => 0,
    );
    expect(resolved.flags.pf2e.rulesSelections.damageType).toBe("fire");
  });

  it("leaves an item with no ChoiceSet completely unchanged", () => {
    const plain = { name: "Longsword", system: { rules: [] }, flags: {} };
    expect(resolveChoiceSetsOnItemData(plain)).toEqual(plain);
  });

  it("leaves an item with no system.rules at all unchanged (not every item has one)", () => {
    const plain = { name: "Longsword" };
    expect(resolveChoiceSetsOnItemData(plain)).toEqual(plain);
  });
});

describe("#897 resolveChoiceSetsOnActorData", () => {
  it("resolves ChoiceSets on every embedded item, not just the actor's own top-level rules", () => {
    const actorData = { name: "Test NPC", items: [itemWithChoiceSet(), { name: "Fists", system: { rules: [] } }] };
    const resolved = resolveChoiceSetsOnActorData(actorData, () => 0);
    expect(resolved.items[0].flags.pf2e.rulesSelections.damageType).toBe("acid");
    expect(resolved.items[1]).toEqual(actorData.items[1]);
  });

  it("leaves an actor with no items array unchanged", () => {
    const actorData = { name: "Test NPC" };
    expect(resolveChoiceSetsOnActorData(actorData)).toEqual(actorData);
  });
});
