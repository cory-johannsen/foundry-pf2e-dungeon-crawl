import { describe, it, expect } from "vitest";
import {
  DETECTION,
  avoidingNoticeActorIds,
  initialDetection,
  canTargetState,
  stateFor,
  afterAttack,
  applySeekOutcome,
  hostileAwareness,
  uniformCondition,
} from "../scripts/stealth-detection.mjs";

describe("DETECTION", () => {
  it("has the four PF2e states", () => {
    expect(DETECTION).toEqual({
      UNNOTICED: "unnoticed",
      UNDETECTED: "undetected",
      HIDDEN: "hidden",
      OBSERVED: "observed",
    });
  });
});

describe("avoidingNoticeActorIds", () => {
  const item = { id: "i1", slug: "avoid-notice" };
  const other = { id: "i2", slug: "scout" };
  it("returns actors whose exploration includes an avoid-notice item", () => {
    const actors = [
      { id: "a", exploration: ["i1"], items: [item, other] },
      { id: "b", exploration: ["i2"], items: [item, other] },
    ];
    expect(avoidingNoticeActorIds(actors)).toEqual(["a"]);
  });
  it("returns nothing without the item", () => {
    expect(avoidingNoticeActorIds([{ id: "a", exploration: ["i2"], items: [other] }])).toEqual([]);
  });
  it("ignores an owned avoid-notice item that is not selected in exploration", () => {
    expect(avoidingNoticeActorIds([{ id: "a", exploration: [], items: [item] }])).toEqual([]);
  });
  it("handles empty input and missing arrays", () => {
    expect(avoidingNoticeActorIds([])).toEqual([]);
    expect(avoidingNoticeActorIds([{ id: "a" }])).toEqual([]);
  });
});

describe("initialDetection", () => {
  it("result equal to DC is unnoticed", () => {
    expect(initialDetection({ sneakers: [{ id: "s", result: 15 }], hostiles: [{ id: "h", dc: 15 }] }))
      .toEqual({ s: { h: "unnoticed" } });
  });
  it("result above DC is unnoticed", () => {
    expect(initialDetection({ sneakers: [{ id: "s", result: 20 }], hostiles: [{ id: "h", dc: 15 }] }).s.h)
      .toBe("unnoticed");
  });
  it("result one below DC is observed", () => {
    expect(initialDetection({ sneakers: [{ id: "s", result: 14 }], hostiles: [{ id: "h", dc: 15 }] }).s.h)
      .toBe("observed");
  });
  it("alarm rule: one observed pair turns every unnoticed pair undetected", () => {
    const m = initialDetection({
      sneakers: [{ id: "s1", result: 20 }, { id: "s2", result: 5 }],
      hostiles: [{ id: "h1", dc: 15 }, { id: "h2", dc: 25 }],
    });
    expect(m).toEqual({
      s1: { h1: "undetected", h2: "observed" },
      s2: { h1: "observed", h2: "observed" },
    });
  });
  it("alarm rule leaves observed pairs observed", () => {
    const m = initialDetection({
      sneakers: [{ id: "s", result: 10 }],
      hostiles: [{ id: "h1", dc: 10 }, { id: "h2", dc: 11 }],
    });
    expect(m.s).toEqual({ h1: "undetected", h2: "observed" });
  });
  it("all unnoticed stays unnoticed", () => {
    const m = initialDetection({
      sneakers: [{ id: "s1", result: 20 }, { id: "s2", result: 18 }],
      hostiles: [{ id: "h1", dc: 15 }, { id: "h2", dc: 16 }],
    });
    expect(m).toEqual({
      s1: { h1: "unnoticed", h2: "unnoticed" },
      s2: { h1: "unnoticed", h2: "unnoticed" },
    });
  });
  it("no sneakers or no hostiles", () => {
    expect(initialDetection({ sneakers: [], hostiles: [{ id: "h", dc: 10 }] })).toEqual({});
    expect(initialDetection({ sneakers: [{ id: "s", result: 10 }], hostiles: [] })).toEqual({ s: {} });
  });
});

describe("canTargetState", () => {
  it("only observed (or missing) is targetable", () => {
    expect(canTargetState("observed")).toBe(true);
    expect(canTargetState(undefined)).toBe(true);
    expect(canTargetState("hidden")).toBe(false);
    expect(canTargetState("undetected")).toBe(false);
    expect(canTargetState("unnoticed")).toBe(false);
  });
});

describe("stateFor", () => {
  const m = { s: { h: "hidden" } };
  it("returns the stored state", () => expect(stateFor(m, "s", "h")).toBe("hidden"));
  it("defaults to observed when absent", () => {
    expect(stateFor(m, "s", "x")).toBe("observed");
    expect(stateFor(m, "nope", "h")).toBe("observed");
    expect(stateFor(undefined, "s", "h")).toBe("observed");
    expect(stateFor(null, "s", "h")).toBe("observed");
  });
});

describe("afterAttack", () => {
  const m = {
    s1: { a: "unnoticed", b: "undetected", c: "observed", d: "hidden" },
    s2: { a: "unnoticed" },
  };
  it("reveals unnoticed/undetected as hidden for that sneaker only", () => {
    const r = afterAttack(m, "s1");
    expect(r.s1).toEqual({ a: "hidden", b: "hidden", c: "observed", d: "hidden" });
    expect(r.s2).toEqual({ a: "unnoticed" });
  });
  it("does not mutate the input", () => {
    const snap = JSON.parse(JSON.stringify(m));
    const r = afterAttack(m, "s1");
    expect(m).toEqual(snap);
    expect(r).not.toBe(m);
    expect(r.s1).not.toBe(m.s1);
  });
  it("unknown sneaker returns an equal matrix", () => {
    expect(afterAttack(m, "zz")).toEqual(m);
  });
});

describe("applySeekOutcome", () => {
  const rows = {
    observed: { criticalSuccess: "observed", success: "observed", failure: "observed", criticalFailure: "observed" },
    unnoticed: { criticalSuccess: "unnoticed", success: "unnoticed", failure: "unnoticed", criticalFailure: "unnoticed" },
    hidden: { criticalSuccess: "observed", success: "observed", failure: "hidden", criticalFailure: "hidden" },
    undetected: { criticalSuccess: "observed", success: "hidden", failure: "undetected", criticalFailure: "undetected" },
  };
  for (const [state, outcomes] of Object.entries(rows)) {
    for (const [outcome, expected] of Object.entries(outcomes)) {
      it(`${state} + ${outcome} -> ${expected}`, () => {
        expect(applySeekOutcome(state, outcome)).toBe(expected);
      });
    }
  }
});

describe("hostileAwareness", () => {
  it("unaware when every sneaker is unnoticed", () => {
    const m = { s1: { h: "unnoticed" }, s2: { h: "unnoticed" } };
    expect(hostileAwareness(m, "h", ["s1", "s2"])).toEqual({ targetable: [], seekable: [], unaware: true });
  });
  it("seekable when hidden or undetected", () => {
    const m = { s1: { h: "hidden" }, s2: { h: "undetected" } };
    expect(hostileAwareness(m, "h", ["s1", "s2"])).toEqual({ targetable: [], seekable: ["s1", "s2"], unaware: false });
  });
  it("targetable when observed", () => {
    const m = { s1: { h: "observed" } };
    expect(hostileAwareness(m, "h", ["s1"])).toEqual({ targetable: ["s1"], seekable: [], unaware: false });
  });
  it("mixed states", () => {
    const m = { s1: { h: "observed" }, s2: { h: "hidden" }, s3: { h: "unnoticed" } };
    expect(hostileAwareness(m, "h", ["s1", "s2", "s3"])).toEqual({
      targetable: ["s1"], seekable: ["s2"], unaware: false,
    });
  });
  it("unnoticed alongside a non-sneaker party member is not unaware", () => {
    const m = { s1: { h: "unnoticed" } };
    const r = hostileAwareness(m, "h", ["s1", "p"]);
    expect(r).toEqual({ targetable: ["p"], seekable: [], unaware: false });
  });
  it("no sneakers: everyone targetable, never unaware", () => {
    expect(hostileAwareness({}, "h", ["p1", "p2"])).toEqual({ targetable: ["p1", "p2"], seekable: [], unaware: false });
    expect(hostileAwareness(undefined, "h", ["p1"])).toEqual({ targetable: ["p1"], seekable: [], unaware: false });
  });
  it("unknown party ids are targetable", () => {
    const m = { s1: { h: "hidden" } };
    expect(hostileAwareness(m, "h", ["s1", "ghost"])).toEqual({
      targetable: ["ghost"], seekable: ["s1"], unaware: false,
    });
  });
  it("empty party is not unaware", () => {
    expect(hostileAwareness({ s1: { h: "unnoticed" } }, "h", []).unaware).toBe(false);
  });
});

describe("uniformCondition", () => {
  it("unnoticed when all unnoticed", () => {
    expect(uniformCondition({ s: { a: "unnoticed", b: "unnoticed" } }, "s")).toBe("unnoticed");
  });
  it("undetected when all undetected", () => {
    expect(uniformCondition({ s: { a: "undetected", b: "undetected" } }, "s")).toBe("undetected");
  });
  it("hidden when all hidden", () => {
    expect(uniformCondition({ s: { a: "hidden" } }, "s")).toBe("hidden");
  });
  it("null when mixed", () => {
    expect(uniformCondition({ s: { a: "unnoticed", b: "undetected" } }, "s")).toBeNull();
    expect(uniformCondition({ s: { a: "observed", b: "observed" } }, "s")).toBeNull();
  });
  it("null for unknown sneaker or empty row", () => {
    expect(uniformCondition({ s: {} }, "s")).toBeNull();
    expect(uniformCondition({}, "s")).toBeNull();
  });
});

describe("initialDetection hasObservedNonSneaker (#616)", () => {
  it("fires the alarm when a non-sneaking party member is observed", () => {
    const m = initialDetection({
      sneakers: [{ id: "s", result: 30 }],
      hostiles: [{ id: "h", dc: 10 }],
      hasObservedNonSneaker: true,
    });
    expect(m).toEqual({ s: { h: "undetected" } });
  });
  it("defaults to false (unchanged)", () => {
    const m = initialDetection({ sneakers: [{ id: "s", result: 30 }], hostiles: [{ id: "h", dc: 10 }] });
    expect(m).toEqual({ s: { h: "unnoticed" } });
  });
  it("no hostiles: nothing to alarm", () => {
    expect(initialDetection({ sneakers: [{ id: "s", result: 1 }], hostiles: [], hasObservedNonSneaker: true })).toEqual({ s: {} });
  });
});
