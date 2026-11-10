import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { activityHasMoveChild } from "../scripts/defensive-advance-logic.mjs";

// Contract guard (#1278): a copy of pf2e-auto-action-tracker's own Defensive
// Advance library entry (src/complexActions/library.ts). A failure here means
// the tracker changed the activity, and the module's ordering assumption
// (shield raised first, then Stride, then optional Strike) must be re-checked.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/tracker-defensive-advance-activity.json", import.meta.url), "utf8"));
const actions = fixture.childActions.filter((n) => n.type === "ACTION");
const operators = fixture.childActions.filter((n) => n.type === "OPERATOR");

describe("tracker Defensive Advance activity contract", () => {
  it("orders raise-a-shield, stride, strike", () => {
    expect(actions.map((a) => a.properties.subtype)).toEqual(["raise-a-shield", "stride", "strike"]);
  });

  it("chains every step with THEN", () => {
    expect(operators.length).toBeGreaterThan(0);
    expect(operators.every((o) => o.value === "THEN")).toBe(true);
  });

  it("makes the Strike optional and single", () => {
    const strike = actions[2].properties;
    expect(strike.minOccurrences).toBe(0);
    expect(strike.maxOccurrences).toBe(1);
  });

  it("activityHasMoveChild recognises the stride node's leaf type", () => {
    const moveType = actions[1].properties.type;
    const log = (childActions) => [{ msgId: "m1", ComplexActionState: { leaves: { s: { type: moveType, childActions } } } }];
    expect(activityHasMoveChild(log([{ msgId: "x" }]), "m1")).toBe(true);
    expect(activityHasMoveChild(log([]), "m1")).toBe(false);
  });
});
