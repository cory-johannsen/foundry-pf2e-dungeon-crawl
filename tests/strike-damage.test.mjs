import { describe, it, expect, vi } from "vitest";
import { rollStrikeDamage } from "../scripts/strike-damage.mjs";

const mkStrike = () => ({
  damage: vi.fn(async () => ({ total: 7 })),
  critical: vi.fn(async () => ({ total: 14 })),
});
const target = { document: { id: "t" } };

describe("rollStrikeDamage (#1284)", () => {
  it("a critical success rolls strike.critical, not strike.damage", async () => {
    const s = mkStrike();
    const roll = await rollStrikeDamage(s, { target, outcome: "criticalSuccess", createMessage: true });
    expect(s.critical).toHaveBeenCalledTimes(1);
    expect(s.damage).not.toHaveBeenCalled();
    expect(roll).toEqual({ total: 14 });
  });

  it("a success rolls strike.damage, not strike.critical", async () => {
    const s = mkStrike();
    const roll = await rollStrikeDamage(s, { target, outcome: "success", createMessage: true });
    expect(s.damage).toHaveBeenCalledTimes(1);
    expect(s.critical).not.toHaveBeenCalled();
    expect(roll).toEqual({ total: 7 });
  });

  it("never forwards outcome to PF2e (it would be silently ignored)", async () => {
    const s = mkStrike();
    await rollStrikeDamage(s, { target, outcome: "criticalSuccess" });
    await rollStrikeDamage(s, { target, outcome: "success" });
    expect(s.critical.mock.calls[0][0]).toEqual({ target, createMessage: true });
    expect(s.damage.mock.calls[0][0]).toEqual({ target, createMessage: true });
    expect(s.critical.mock.calls[0][0]).not.toHaveProperty("outcome");
    expect(s.damage.mock.calls[0][0]).not.toHaveProperty("outcome");
  });

  it("createMessage defaults to true and can be turned off", async () => {
    const s = mkStrike();
    await rollStrikeDamage(s, { target, outcome: "success" });
    await rollStrikeDamage(s, { target, outcome: "success", createMessage: false });
    expect(s.damage.mock.calls[0][0].createMessage).toBe(true);
    expect(s.damage.mock.calls[1][0].createMessage).toBe(false);
  });

  it("an unknown or missing outcome rolls plain damage (callers only reach here on a hit)", async () => {
    const s = mkStrike();
    await rollStrikeDamage(s, { target });
    expect(s.damage).toHaveBeenCalledTimes(1);
    expect(s.critical).not.toHaveBeenCalled();
  });

  it("a strike object lacking critical() throws a TypeError on a crit instead of silently rolling normal damage", () => {
    const s = { damage: vi.fn(async () => ({ total: 7 })) };
    expect(() => rollStrikeDamage(s, { target, outcome: "criticalSuccess" })).toThrow(TypeError);
    expect(s.damage).not.toHaveBeenCalled();
  });

  it("propagates a null roll (PF2e returns null for a weapon that deals no damage)", async () => {
    const s = { damage: vi.fn(async () => null), critical: vi.fn(async () => null) };
    expect(await rollStrikeDamage(s, { target, outcome: "criticalSuccess" })).toBeNull();
  });
});
