import { describe, it, expect } from "vitest";
import {
  isDefensiveAdvanceMessage, createPendingStore, armPending, peekPending, consumePending,
  clearPendingWhere, resolveTargetToken, validateTarget, pickMeleeStrike, countMapAttacks,
  mapVariantIndex, logHasMessage, activityHasMoveChild, degreeToOutcome,
} from "../scripts/defensive-advance-logic.mjs";

const featCard = (over = {}) => ({
  flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:defensive-advance"] } } },
  ...over,
});

describe("isDefensiveAdvanceMessage", () => {
  it("accepts the feat card", () => expect(isDefensiveAdvanceMessage(featCard())).toBe(true));
  it("rejects another feat's card", () => {
    const m = featCard();
    m.flags.pf2e.origin.rollOptions = ["origin:item:slug:devoted-guardian"];
    expect(isDefensiveAdvanceMessage(m)).toBe(false);
  });
  it("rejects a roll made by the feat (has a context)", () => {
    const m = featCard();
    m.flags.pf2e.context = { type: "attack-roll" };
    expect(isDefensiveAdvanceMessage(m)).toBe(false);
  });
  it("rejects a non-feat origin and junk input", () => {
    const m = featCard();
    m.flags.pf2e.origin.type = "action";
    expect(isDefensiveAdvanceMessage(m)).toBe(false);
    expect(isDefensiveAdvanceMessage(null)).toBe(false);
    expect(isDefensiveAdvanceMessage({})).toBe(false);
  });
});

describe("pending store", () => {
  const entry = (over = {}) => ({ tokenId: "t1", combatId: "k1", combatantId: "c1", round: 1, featMessageId: "m1", ...over });
  it("arms, peeks without consuming, then consumes once", () => {
    const s = createPendingStore();
    armPending(s, entry());
    expect(peekPending(s, "t1")).toEqual(entry());
    expect(peekPending(s, "t1")).toEqual(entry());
    expect(consumePending(s, "t1")).toEqual(entry());
    expect(consumePending(s, "t1")).toBeNull();
    expect(peekPending(s, "t1")).toBeNull();
  });
  it("a second arm for the same token replaces the first", () => {
    const s = createPendingStore();
    armPending(s, entry({ featMessageId: "old" }));
    armPending(s, entry({ featMessageId: "new" }));
    expect(peekPending(s, "t1").featMessageId).toBe("new");
    expect(s.size).toBe(1);
  });
  it("clearPendingWhere removes matching entries only and reports the count", () => {
    const s = createPendingStore();
    armPending(s, entry({ tokenId: "a", combatId: "k1" }));
    armPending(s, entry({ tokenId: "b", combatId: "k1" }));
    armPending(s, entry({ tokenId: "c", combatId: "k2" }));
    expect(clearPendingWhere(s, (e) => e.combatId === "k1")).toBe(2);
    expect([...s.keys()]).toEqual(["c"]);
  });
});

describe("resolveTargetToken", () => {
  it("none", () => expect(resolveTargetToken(new Set())).toEqual({ ok: false, reason: "none" }));
  it("many", () => expect(resolveTargetToken(new Set([{}, {}]))).toEqual({ ok: false, reason: "many" }));
  it("exactly one", () => {
    const tok = { id: "x" };
    expect(resolveTargetToken(new Set([tok]))).toEqual({ ok: true, token: tok });
  });
  it("tolerates null/undefined", () => {
    expect(resolveTargetToken(undefined)).toEqual({ ok: false, reason: "none" });
    expect(resolveTargetToken(null)).toEqual({ ok: false, reason: "none" });
  });
});

describe("validateTarget", () => {
  const mover = { id: "c1" };
  it("accepts a living hostile other combatant", () =>
    expect(validateTarget({ targetCombatant: { id: "c2", isDefeated: false }, moverCombatant: mover, hostile: true })).toEqual({ ok: true }));
  it("rejects a target that is not in the combat", () =>
    expect(validateTarget({ targetCombatant: undefined, moverCombatant: mover, hostile: false })).toEqual({ ok: false, reason: "not-in-combat" }));
  it("rejects the mover itself", () =>
    expect(validateTarget({ targetCombatant: { id: "c1" }, moverCombatant: mover, hostile: false })).toEqual({ ok: false, reason: "self" }));
  it("rejects a defeated target", () =>
    expect(validateTarget({ targetCombatant: { id: "c2", isDefeated: true }, moverCombatant: mover, hostile: true })).toEqual({ ok: false, reason: "defeated" }));
  it("rejects an ally", () =>
    expect(validateTarget({ targetCombatant: { id: "c2", isDefeated: false }, moverCombatant: mover, hostile: false })).toEqual({ ok: false, reason: "not-hostile" }));
});

describe("pickMeleeStrike", () => {
  const strike = (name, mod, over = {}) => ({ type: "strike", ready: true, totalModifier: mod, name, ...over });
  const opts = { reachOf: (a) => a.reach ?? 1, isMelee: (a) => !a.ranged };
  it("picks the highest modifier among melee strikes in reach", () => {
    const actions = [strike("fist", 5), strike("sword", 9), strike("bow", 12, { ranged: true })];
    expect(pickMeleeStrike(actions, 1, opts).name).toBe("sword");
  });
  it("skips strikes that are not ready or not strikes", () => {
    const actions = [strike("sheathed", 20, { ready: false }), { type: "action", totalModifier: 30 }, strike("fist", 5)];
    expect(pickMeleeStrike(actions, 1, opts).name).toBe("fist");
  });
  it("honours a longer reach and excludes a target out of reach", () => {
    const actions = [strike("fist", 5), strike("glaive", 3, { reach: 2 })];
    expect(pickMeleeStrike(actions, 2, opts).name).toBe("glaive");
    expect(pickMeleeStrike(actions, 3, opts)).toBeNull();
  });
  it("returns null with no usable strike or bad input", () => {
    expect(pickMeleeStrike([strike("bow", 9, { ranged: true })], 1, opts)).toBeNull();
    expect(pickMeleeStrike(undefined, 1, opts)).toBeNull();
  });
});

describe("MAP from the tracker log", () => {
  const atk = (over = {}) => ({ msgId: "a", isMapRelevant: true, type: "action", ...over });
  it("counts no prior attacks as variant 0", () => {
    expect(countMapAttacks([])).toBe(0);
    expect(mapVariantIndex([])).toBe(0);
  });
  it("counts map-relevant top-level entries, ignoring reactions and deferMAP", () => {
    expect(countMapAttacks([atk(), atk({ type: "reaction" }), atk({ actionModifiers: ["deferMAP"] }), { msgId: "s", isMapRelevant: false }])).toBe(1);
  });
  it("counts an activity's children, including the doubled mapIncrease2", () => {
    const activity = { msgId: "f", isMapRelevant: false, ComplexActionState: { orderedActivityChildActions: [atk({ actionModifiers: ["mapIncrease2"] })] } };
    expect(countMapAttacks([activity])).toBe(2);
  });
  it("clamps the variant index to 2", () => {
    expect(mapVariantIndex([atk(), atk(), atk(), atk()])).toBe(2);
    expect(mapVariantIndex([atk()])).toBe(1);
  });
});

describe("tracker log predicates", () => {
  it("logHasMessage", () => {
    expect(logHasMessage([{ msgId: "m1" }], "m1")).toBe(true);
    expect(logHasMessage([{ msgId: "m1" }], "m2")).toBe(false);
    expect(logHasMessage(undefined, "m1")).toBe(false);
  });
  const activity = (leaves) => [{ msgId: "f", ComplexActionState: { leaves } }];
  it("activityHasMoveChild is true only once the move leaf has a claimed child", () => {
    expect(activityHasMoveChild(activity({ a: { type: "action", childActions: [{}] }, b: { type: "move", childActions: [] } }), "f")).toBe(false);
    expect(activityHasMoveChild(activity({ b: { type: "move", childActions: [{ msgId: "x" }] } }), "f")).toBe(true);
  });
  it("activityHasMoveChild is false for a missing entry or activity", () => {
    expect(activityHasMoveChild([], "f")).toBe(false);
    expect(activityHasMoveChild([{ msgId: "f" }], "f")).toBe(false);
    expect(activityHasMoveChild(undefined, "f")).toBe(false);
  });
});

describe("degreeToOutcome", () => {
  it("maps hits and crits, nothing else", () => {
    expect(degreeToOutcome(3)).toBe("criticalSuccess");
    expect(degreeToOutcome(2)).toBe("success");
    expect(degreeToOutcome(1)).toBeNull();
    expect(degreeToOutcome(0)).toBeNull();
    expect(degreeToOutcome(undefined)).toBeNull();
  });
});
