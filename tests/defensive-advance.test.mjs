import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  onDefensiveAdviceCard, pendingDefensiveAdvance, waitForTrackerLog,
} from "../scripts/defensive-advance.mjs";
import { TRACKER_NAMESPACE } from "../scripts/defensive-advance-logic.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function world({ shield = { isRaised: false }, trackerLog = [{ msgId: "m1" }], agent = false, current = true, defeated = false } = {}) {
  const mover = {
    id: "c1", tokenId: "t1", isDefeated: defeated,
    getFlag: (scope, key) => (scope === MODULE_ID && key === "agentControlled" ? agent : undefined),
    flags: { [TRACKER_NAMESPACE]: { log: trackerLog } },
    actor: { heldShield: shield },
  };
  const combat = {
    id: "k1", round: 2, started: true, scene: { id: "s1" },
    combatant: current ? mover : { id: "other" },
    combatants: { find: (fn) => [mover].find(fn), get: (id) => [mover].find((c) => c.id === id) },
  };
  const game = { user: { id: "u1", targets: new Set() }, combats: { contents: [combat], get: () => combat } };
  return { mover, combat, game };
}
const card = (over = {}) => ({
  id: "m1", author: { id: "u1" }, speaker: { scene: "s1", token: "t1" },
  flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:defensive-advance"] } } },
  ...over,
});
const mkDeps = (w, over = {}) => ({
  game: w.game, log: { error: vi.fn(), warn: vi.fn() }, notify: vi.fn(),
  raiseAShield: vi.fn(async () => {}), sleepFn: vi.fn(async () => {}), isModuleCombat: () => true, ...over,
});

beforeEach(() => pendingDefensiveAdvance.clear());

describe("onDefensiveAdviceCard", () => {
  it("raises the shield and arms the pending Strike", async () => {
    const w = world(); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
    expect(deps.raiseAShield).toHaveBeenCalledWith({ actors: [w.mover.actor] });
    expect(pendingDefensiveAdvance.get("t1")).toEqual({
      tokenId: "t1", combatId: "k1", combatantId: "c1", round: 2, featMessageId: "m1",
    });
  });

  it("never lowers an already-raised shield (raiseAShield is a toggle) but still arms", async () => {
    const w = world({ shield: { isRaised: true } }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.ShieldAlreadyRaised");
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });

  it("with no shield, notifies, does not raise, and still arms", async () => {
    const w = world({ shield: null }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.DefensiveAdvance.NoShield");
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });

  it("waits for the tracker to log the feat card before raising", async () => {
    const w = world({ trackerLog: [] });
    let calls = 0;
    const deps = mkDeps(w, {
      sleepFn: vi.fn(async () => { if (++calls === 3) w.mover.flags[TRACKER_NAMESPACE].log = [{ msgId: "m1" }]; }),
    });
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.sleepFn).toHaveBeenCalledTimes(3);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
  });

  it("raises anyway after the wait times out", async () => {
    const w = world({ trackerLog: [] }); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(), deps);
    expect(deps.raiseAShield).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another feat", { flags: { pf2e: { origin: { type: "feat", rollOptions: ["origin:item:slug:devoted-guardian"] } } } }, {}],
    ["another user's card", { author: { id: "u2" } }, {}],
    ["an AI-controlled combatant", {}, { agent: true }],
    ["not the combatant's turn", {}, { current: false }],
    ["a defeated combatant", {}, { defeated: true }],
  ])("does nothing for %s", async (_name, msgOver, worldOver) => {
    const w = world(worldOver); const deps = mkDeps(w);
    await onDefensiveAdviceCard(card(msgOver), deps);
    expect(deps.raiseAShield).not.toHaveBeenCalled();
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("does nothing outside a module combat", async () => {
    const w = world(); const deps = mkDeps(w, { isModuleCombat: () => false });
    await onDefensiveAdviceCard(card(), deps);
    expect(pendingDefensiveAdvance.size).toBe(0);
  });

  it("never throws: a failing raise is logged and the Strike still stays armed", async () => {
    const w = world(); const deps = mkDeps(w, { raiseAShield: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(onDefensiveAdviceCard(card(), deps)).resolves.toBeUndefined();
    expect(deps.log.error).toHaveBeenCalled();
    expect(pendingDefensiveAdvance.has("t1")).toBe(true);
  });
});

describe("waitForTrackerLog", () => {
  it("resolves true immediately when the predicate already holds", async () => {
    const c = { flags: { [TRACKER_NAMESPACE]: { log: [{ msgId: "m1" }] } } };
    const sleepFn = vi.fn(async () => {});
    expect(await waitForTrackerLog(c, (l) => l.length === 1, { sleepFn })).toBe(true);
    expect(sleepFn).not.toHaveBeenCalled();
  });
  it("resolves false after the attempts are used up, treating a missing log as empty", async () => {
    const c = { flags: {} };
    const sleepFn = vi.fn(async () => {});
    expect(await waitForTrackerLog(c, (l) => l.length > 0, { attempts: 4, sleepFn })).toBe(false);
    expect(sleepFn).toHaveBeenCalledTimes(4);
  });
});
