import { describe, it, expect } from "vitest";
import {
  classifyCombatantUpdate, isValidQueueValue, validateRelayMessage,
} from "../scripts/combatant-write-relay.mjs";

const NS = "pf2e-auto-action-tracker";
describe("classifyCombatantUpdate", () => {
  it("relays an expanded damage-queue write from a player", () => {
    expect(classifyCombatantUpdate({ _id: "c", flags: { [NS]: { pendingDamageQueue: ["m1"] } } }, false))
      .toEqual({ relay: true, flagKey: "pendingDamageQueue", value: ["m1"] });
  });
  it("relays a dotted-key attack-queue write", () => {
    expect(classifyCombatantUpdate({ [`flags.${NS}.pendingAttackQueue`]: [] }, false))
      .toEqual({ relay: true, flagKey: "pendingAttackQueue", value: [] });
  });
  it("never relays for a GM", () => {
    expect(classifyCombatantUpdate({ flags: { [NS]: { pendingDamageQueue: ["m1"] } } }, true)).toEqual({ relay: false });
  });
  it("does not relay when anything else is in the update", () => {
    const f = (ch) => classifyCombatantUpdate(ch, false);
    expect(f({ flags: { [NS]: { pendingDamageQueue: [], pendingAttackQueue: [] } } })).toEqual({ relay: false }); // two keys
    expect(f({ flags: { [NS]: { pendingDamageQueue: [], log: [] } } })).toEqual({ relay: false });
    expect(f({ flags: { [NS]: { log: [] } } })).toEqual({ relay: false });
    expect(f({ flags: { other: { x: 1 }, [NS]: { pendingDamageQueue: [] } } })).toEqual({ relay: false });
    expect(f({ initiative: 5, flags: { [NS]: { pendingDamageQueue: [] } } })).toEqual({ relay: false });
    expect(f({ flags: { [NS]: { "-=pendingDamageQueue": null } } })).toEqual({ relay: false });
    expect(f({})).toEqual({ relay: false });
    expect(f(null)).toEqual({ relay: false });
  });
  it("allows _id alongside the flag", () => {
    expect(classifyCombatantUpdate({ _id: "c", flags: { [NS]: { pendingAttackQueue: ["a"] } } }, false).relay).toBe(true);
  });
  it("rejects malformed values", () => {
    expect(classifyCombatantUpdate({ flags: { [NS]: { pendingDamageQueue: "m1" } } }, false)).toEqual({ relay: false });
    expect(classifyCombatantUpdate({ flags: { [NS]: { pendingDamageQueue: [1] } } }, false)).toEqual({ relay: false });
    expect(classifyCombatantUpdate({ flags: { [NS]: { pendingDamageQueue: Array(51).fill("x") } } }, false)).toEqual({ relay: false });
  });
});

describe("isValidQueueValue", () => {
  it("accepts ≤50 strings only", () => {
    expect(isValidQueueValue([])).toBe(true);
    // eslint-disable-next-line no-sparse-arrays
    expect(isValidQueueValue(["a", , "b"])).toBe(false);
    expect(isValidQueueValue(new Array(3))).toBe(false);
    expect(isValidQueueValue(Array(50).fill("x"))).toBe(true);
    expect(isValidQueueValue(Array(51).fill("x"))).toBe(false);
    expect(isValidQueueValue(null)).toBe(false);
  });
});

describe("validateRelayMessage", () => {
  const owner = { id: "u1" };
  const combatant = { id: "cb", actor: { testUserPermission: (u, lvl) => u.id === "u1" && lvl === "OWNER" } };
  const combat = { combatants: { get: (id) => (id === "cb" ? combatant : undefined) } };
  const msg = { combatId: "x", combatantId: "cb", flagKey: "pendingDamageQueue", value: ["m1"], userId: "u1" };
  it("accepts a valid owner message", () => {
    expect(validateRelayMessage(msg, { combat, senderUser: owner })).toMatchObject({ ok: true, flagKey: "pendingDamageQueue", value: ["m1"] });
  });
  it.each([
    ["unlisted key", { ...msg, flagKey: "log" }, { combat, senderUser: owner }],
    ["bad value", { ...msg, value: "m1" }, { combat, senderUser: owner }],
    ["unknown combat", msg, { combat: undefined, senderUser: owner }],
    ["unknown combatant", { ...msg, combatantId: "zz" }, { combat, senderUser: owner }],
    ["unknown sender", msg, { combat, senderUser: undefined }],
    ["non-owner sender", msg, { combat, senderUser: { id: "u2" } }],
  ])("rejects %s", (_n, m, ctx) => {
    expect(validateRelayMessage(m, ctx).ok).toBe(false);
  });
});

describe("classifyCombatantUpdate extra shapes (review focus)", () => {
  const f = (ch) => classifyCombatantUpdate(ch, false);
  it("handles dotted + expanded mixed and dotted -= keys", () => {
    expect(f({ [`flags.${NS}.pendingDamageQueue`]: ["a"], [`flags.${NS}.pendingAttackQueue`]: [] })).toEqual({ relay: false });
    expect(f({ [`flags.${NS}.-=pendingDamageQueue`]: null })).toEqual({ relay: false });
    expect(f({ [`flags.${NS}.pendingDamageQueue`]: ["a"], "flags.other.x": 1 })).toEqual({ relay: false });
    expect(f({ [`flags.${NS}.pendingDamageQueue`]: ["a"], name: "x" })).toEqual({ relay: false });
    expect(f({ flags: { [NS]: { pendingAttackQueue: ["a"] } }, [`flags.${NS}.log`]: [] })).toEqual({ relay: false });
  });
  it("is not fooled by prototype-pollution keys", () => {
    expect(f({ "__proto__.polluted": 1 })).toEqual({ relay: false });
    expect({}.polluted).toBeUndefined();
  });
});
