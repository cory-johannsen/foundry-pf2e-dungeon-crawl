import { describe, it, expect, vi } from "vitest";
import { makeFoundryApi } from "../scripts/foundry-api.mjs";

function makeActor({ id, hpValue = 1, hpMax = 20, conditions = [] } = {}) {
  const conditionItems = conditions.map((slug, i) => ({ id: `cond-${i}`, slug }));
  const actor = {
    id,
    system: { attributes: { hp: { value: hpValue, max: hpMax } } },
    itemTypes: { condition: conditionItems },
  };
  actor.deleteEmbeddedDocuments = vi.fn(async (type, ids) => {
    actor.itemTypes.condition = actor.itemTypes.condition.filter((c) => !ids.includes(c.id));
  });
  actor.update = vi.fn(async (changes) => {
    actor.system.attributes.hp.value = changes["system.attributes.hp.value"];
  });
  return actor;
}

function install(actorsById) {
  globalThis.game = { actors: { get: (id) => actorsById[id] } };
}

describe("healAndClearConditions (#617)", () => {
  it("heals to max HP and deletes every condition item in one call", async () => {
    const actor = makeActor({ id: "pc1", hpValue: 1, hpMax: 20, conditions: ["dying", "unconscious", "clumsy"] });
    install({ pc1: actor });

    await makeFoundryApi().healAndClearConditions("pc1");

    expect(actor.system.attributes.hp.value).toBe(20);
    expect(actor.itemTypes.condition).toHaveLength(0);
    expect(actor.deleteEmbeddedDocuments).toHaveBeenCalledWith("Item", ["cond-0", "cond-1", "cond-2"]);
  });

  it("still heals to max HP when there are no conditions, without calling deleteEmbeddedDocuments", async () => {
    const actor = makeActor({ id: "pc1", hpValue: 5, hpMax: 20, conditions: [] });
    install({ pc1: actor });

    await makeFoundryApi().healAndClearConditions("pc1");

    expect(actor.system.attributes.hp.value).toBe(20);
    expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
  });

  it("heals to whatever max currently is, not a hardcoded value", async () => {
    const actor = makeActor({ id: "pc1", hpValue: 1, hpMax: 47, conditions: [] });
    install({ pc1: actor });

    await makeFoundryApi().healAndClearConditions("pc1");

    expect(actor.system.attributes.hp.value).toBe(47);
  });

  it("throws a clear error for an unknown actor id", async () => {
    install({});
    await expect(makeFoundryApi().healAndClearConditions("missing")).rejects.toThrow(/No actor: missing/);
  });
});
