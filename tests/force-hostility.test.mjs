import { describe, it, expect, vi } from "vitest";
import {
  areHostile, areHostileForces, withRetaliation, recordAttack, forceIdOf, readForces,
} from "../scripts/force-hostility.mjs";

const M = "pf2e-dungeon-crawl";
const mk = (id, disposition, forceId) => ({
  id,
  token: { disposition, flags: forceId ? { [M]: { forceId } } : {} },
});
const forces = () => ({
  f1: { hostility: "all", hostileTo: [] },
  f2: { hostility: "players", hostileTo: [] },
  f3: { hostility: "players", hostileTo: [] },
});
const combatWith = (table) => ({ getFlag: (m, k) => (k === "forces" ? table : undefined), setFlag: vi.fn() });

describe("forceIdOf", () => {
  it("uses the token flag, else party/default by disposition", () => {
    expect(forceIdOf(mk("a", -1, "f2"))).toBe("f2");
    expect(forceIdOf(mk("a", 1))).toBe("party");
    expect(forceIdOf(mk("a", 0))).toBe("party");
    expect(forceIdOf(mk("a", -1))).toBe("default");
  });
});

describe("forceIdOf hardening (#1083 final review)", () => {
  it("a non-hostile token is party even if a stale forceId flag is present", () => {
    expect(forceIdOf(mk("fr", 1, "f1"))).toBe("party");
    expect(forceIdOf(mk("n", 0, "f1"))).toBe("party");
  });
  it("a friend carrying a force flag is not hostile to the party and not an ally of the force", () => {
    const c = combatWith(forces());
    const friend = mk("fr", 1, "f2");
    expect(areHostile(c, mk("p", 1), friend)).toBe(false);
    expect(areHostile(c, friend, mk("g", -1, "f2"))).toBe(true);
  });
});

describe("readForces / lookups hardening", () => {
  it("rejects arrays and non-objects", () => {
    expect(readForces({ getFlag: () => [] })).toBeNull();
    expect(readForces({ getFlag: () => "x" })).toBeNull();
    expect(readForces(combatWith(forces()))).not.toBeNull();
  });
  it("does not resolve inherited keys as forces", () => {
    const t = forces();
    // "constructor" must be treated as an unknown force (hostile to players), not Object's constructor
    expect(areHostileForces(t, "constructor", "toString")).toBe(false);
    expect(areHostileForces(t, "constructor", "party")).toBe(true);
    expect(withRetaliation(t, "f1", "constructor")).toBe(t);
  });
});

describe("areHostileForces", () => {
  it("party is hostile to every force; never to itself", () => {
    expect(areHostileForces(forces(), "party", "f1")).toBe(true);
    expect(areHostileForces(forces(), "f2", "party")).toBe(true);
    expect(areHostileForces(forces(), "party", "party")).toBe(false);
  });
  it("same force never hostile", () => {
    expect(areHostileForces(forces(), "f1", "f1")).toBe(false);
  });
  it("'all' is hostile to other forces both ways; players-vs-players indifferent", () => {
    expect(areHostileForces(forces(), "f1", "f2")).toBe(true);
    expect(areHostileForces(forces(), "f2", "f1")).toBe(true);
    expect(areHostileForces(forces(), "f2", "f3")).toBe(false);
  });
  it("retaliation edge makes players forces hostile", () => {
    const t = forces();
    t.f2.hostileTo = ["f3"];
    expect(areHostileForces(t, "f2", "f3")).toBe(true);
    expect(areHostileForces(t, "f3", "f2")).toBe(true);
  });
  it("unknown force id is treated as hostile to players", () => {
    expect(areHostileForces(forces(), "ghost", "party")).toBe(true);
  });
  it("null table = legacy (party vs hostile only)", () => {
    expect(areHostileForces(null, "party", "default")).toBe(true);
    expect(areHostileForces(null, "default", "default")).toBe(false);
  });
});

describe("areHostile (combatants)", () => {
  it("uses force ids from tokens and the combat table", () => {
    const c = combatWith(forces());
    expect(areHostile(c, mk("u", -1, "f1"), mk("g", -1, "f2"))).toBe(true);
    expect(areHostile(c, mk("g1", -1, "f2"), mk("g2", -1, "f2"))).toBe(false);
    expect(areHostile(c, mk("p", 1), mk("g", -1, "f2"))).toBe(true);
    expect(areHostile(c, mk("p", 1), mk("p", 1))).toBe(false);
  });
  it("legacy combat without a table matches old disposition rule", () => {
    const c = combatWith(undefined);
    expect(areHostile(c, mk("p", 1), mk("m", -1))).toBe(true);
    expect(areHostile(c, mk("m1", -1), mk("m2", -1))).toBe(false);
  });
});

describe("withRetaliation / recordAttack", () => {
  it("goblins (players) attacked by undead: goblins become hostile to undead force", () => {
    const next = withRetaliation(forces(), "f1", "f2");
    expect(next.f2.hostileTo).toContain("f1");
  });
  it("symmetric when the attacker force is players-mode", () => {
    const next = withRetaliation(forces(), "f3", "f2");
    expect(next.f3.hostileTo).toContain("f2");
    expect(next.f2.hostileTo).toContain("f3");
  });
  it("party attacking never records an edge; victim party and same-force are no-ops", () => {
    const t = forces();
    expect(withRetaliation(t, "party", "f2")).toEqual(t);
    expect(withRetaliation(t, "f2", "party")).toEqual(t);
    expect(withRetaliation(t, "f2", "f2")).toEqual(t);
    expect(withRetaliation(null, "f1", "f2")).toBeNull();
  });
  it("does not mutate its input", () => {
    const t = forces();
    withRetaliation(t, "f1", "f2");
    expect(t.f2.hostileTo).toEqual([]);
  });
  it("recordAttack writes the flag only when the table changed, and swallows errors", async () => {
    const c = combatWith(forces());
    await recordAttack(c, mk("u", -1, "f1"), mk("g", -1, "f2"));
    expect(c.setFlag).toHaveBeenCalledTimes(1);
    const c2 = combatWith(forces());
    await recordAttack(c2, mk("p", 1), mk("g", -1, "f2"));
    expect(c2.setFlag).not.toHaveBeenCalled();
    const c3 = combatWith(forces());
    c3.setFlag.mockRejectedValue(new Error("boom"));
    await expect(recordAttack(c3, mk("u", -1, "f1"), mk("g", -1, "f2"))).resolves.toBeUndefined();
  });
});
