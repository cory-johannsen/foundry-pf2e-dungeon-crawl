import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleStealthBreakMessage } from "../scripts/dungeon-combat.mjs";
import { applySeekOutcome } from "../scripts/stealth-detection.mjs";

// #616 Task 5: breaking stealth.

const MOD = "pf2e-dungeon-crawl";

function setup(matrix) {
  const flags = { dungeonSlot: 1, detection: matrix, appliedConditions: {} };
  const mkC = (id) => ({ id, name: id, actor: { id: `actor-${id}`, conditions: [] } });
  const combat = {
    id: "c1",
    combatants: [mkC("s1"), mkC("s2"), mkC("pc"), mkC("h1"), mkC("h2")],
    getFlag: (_m, k) => flags[k],
    setFlag: vi.fn(async (_m, k, v) => {
      flags[k] = v;
    }),
  };
  combat.combatants.find = Array.prototype.find.bind(combat.combatants);
  const deps = {
    combats: [combat],
    isActiveGm: true,
    chat: vi.fn(async () => {}),
    hasCondition: vi.fn(() => false),
    setCondition: vi.fn(async () => {}),
  };
  return { combat, flags, deps };
}

const msg = (actorId, type = "attack-roll") => ({
  flags: { pf2e: { context: { type } } },
  actor: { id: actorId },
});

const matrix = () => ({
  s1: { h1: "unnoticed", h2: "observed" },
  s2: { h1: "undetected", h2: "unnoticed" },
});

beforeEach(() => {
  globalThis.game = { user: { isGM: true }, users: {}, combats: { contents: [] } };
});
afterEach(() => vi.restoreAllMocks());

describe("handleStealthBreakMessage", () => {
  it("turns the sneaker's unnoticed/undetected pairs hidden, leaving observed and other sneakers", async () => {
    const { combat, flags, deps } = setup(matrix());
    await handleStealthBreakMessage(msg("actor-s1"), deps);
    expect(flags.detection.s1).toEqual({ h1: "hidden", h2: "observed" });
    expect(flags.detection.s2).toEqual(matrix().s2);
    expect(deps.chat).toHaveBeenCalledWith("PF2EDC.Dungeon.Combat.StealthRevealedChat", { name: "s1" });
    expect(combat.setFlag).toHaveBeenCalledWith(MOD, "detection", expect.anything());
  });

  it("handles spell-attack-roll and speaker.actor fallback", async () => {
    const { flags, deps } = setup(matrix());
    await handleStealthBreakMessage(
      { flags: { pf2e: { context: { type: "spell-attack-roll" } } }, speaker: { actor: "actor-s2" } },
      deps,
    );
    expect(flags.detection.s2).toEqual({ h1: "hidden", h2: "hidden" });
  });

  it.each([
    ["hostile attack", msg("actor-h1")],
    ["non-sneaker party attack", msg("actor-pc")],
    ["non-attack message", msg("actor-s1", "skill-check")],
    ["no context", { actor: { id: "actor-s1" } }],
  ])("ignores %s (no matrix write)", async (_n, m) => {
    const { combat, deps } = setup(matrix());
    await handleStealthBreakMessage(m, deps);
    expect(combat.setFlag).not.toHaveBeenCalled();
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it("ignores a non-GM client", async () => {
    const { combat, deps } = setup(matrix());
    await handleStealthBreakMessage(msg("actor-s1"), { ...deps, isActiveGm: false });
    expect(combat.setFlag).not.toHaveBeenCalled();
  });

  it("ignores when there is no active combat", async () => {
    const { deps } = setup(matrix());
    await handleStealthBreakMessage(msg("actor-s1"), { ...deps, combats: [] });
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it("does nothing (no write, no chat) when nothing would change", async () => {
    const m = { s1: { h1: "hidden", h2: "observed" } };
    const { combat, deps } = setup(m);
    await handleStealthBreakMessage(msg("actor-s1"), deps);
    expect(combat.setFlag).not.toHaveBeenCalled();
    expect(deps.chat).not.toHaveBeenCalled();
  });

  it("removes the applied display condition once no longer uniform", async () => {
    const { flags, deps } = setup({ s1: { h1: "unnoticed", h2: "unnoticed" } });
    flags.appliedConditions = { s1: { actorId: "actor-s1", slug: "unnoticed" } };
    await handleStealthBreakMessage(msg("actor-s1"), deps);
    expect(flags.detection.s1).toEqual({ h1: "hidden", h2: "hidden" });
    expect(deps.setCondition).toHaveBeenCalledWith(expect.objectContaining({ id: "actor-s1" }), "unnoticed", false);
    expect(flags.appliedConditions).toEqual({});
  });

  it("a Seek-revealed (observed) pair stays observed after the sneaker later attacks", async () => {
    // hostile Seek success on a hidden pair -> observed (RAW), then attack.
    const seeked = { s1: { h1: applySeekOutcome("hidden", "success"), h2: "unnoticed" } };
    expect(seeked.s1.h1).toBe("observed");
    const { flags, deps } = setup(seeked);
    await handleStealthBreakMessage(msg("actor-s1"), deps);
    expect(flags.detection.s1).toEqual({ h1: "observed", h2: "hidden" });
  });
});
