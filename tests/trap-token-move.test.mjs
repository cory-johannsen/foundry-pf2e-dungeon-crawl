import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../scripts/dungeon-runner.mjs", () => ({ applyTrapRoomState: vi.fn() }));

const { handleTrapTokenMove } = await import("../scripts/trap-combat.mjs");

const MODULE_ID = "pf2e-dungeon-crawl";

function fakeFlagged(initial = {}) {
  const flags = { ...initial };
  return {
    flags,
    getFlag: (m, k) => (m === MODULE_ID ? flags[k] : undefined),
    setFlag: vi.fn(async (m, k, v) => {
      flags[k] = v;
    }),
  };
}

function makeHazard({ x, y, hidden = true, actorFlags = {} } = {}) {
  const actor = Object.assign(fakeFlagged(actorFlags), { id: "haz1", name: "Spiked Pit" });
  const tok = {
    x,
    y,
    width: 1,
    height: 1,
    hidden,
    actor,
    flags: {},
    getFlag: (m, k) => (m === MODULE_ID && k === "trapHazard" ? true : tok.flags[k]),
    setFlag: vi.fn(async (m, k, v) => {
      tok.flags[k] = v;
    }),
    update: vi.fn(async (u) => Object.assign(tok, u)),
  };
  return tok;
}

function makeMover(hazards, { x = 100, y = 100 } = {}) {
  const scene = { grid: { size: 100 }, tokens: hazards };
  scene.tokens.filter = Array.prototype.filter.bind(hazards);
  return { x, y, width: 1, height: 1, parent: scene, name: "Valeros", actor: { id: "pc1", name: "Valeros" }, object: { id: "tokobj" } };
}

let triggerTrap, rollTrapDetection, base, announce;
beforeEach(() => {
  triggerTrap = vi.fn(async () => "success");
  rollTrapDetection = vi.fn(async () => ({ detected: true }));
  announce = vi.fn(async () => {});
  base = {
    announce,
    isGM: () => true,
    isPartyActor: () => true,
    triggerTrap,
    rollTrapDetection,
  };
});

const MOVE = { x: 100 };

describe("handleTrapTokenMove", () => {
  it("ignores non-position changes", async () => {
    const h = makeHazard({ x: 100, y: 100 });
    await handleTrapTokenMove(makeMover([h]), { hidden: true }, base);
    expect(triggerTrap).not.toHaveBeenCalled();
    expect(h.actor.setFlag).not.toHaveBeenCalled();
  });

  it("ignores non-GM clients", async () => {
    const h = makeHazard({ x: 100, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, { ...base, isGM: () => false });
    expect(triggerTrap).not.toHaveBeenCalled();
  });

  it("ignores non-party movers", async () => {
    const h = makeHazard({ x: 100, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, { ...base, isPartyActor: () => false });
    expect(triggerTrap).not.toHaveBeenCalled();
    expect(rollTrapDetection).not.toHaveBeenCalled();
  });

  it("adjacent mover detects the trap, sets the flag and unhides", async () => {
    const h = makeHazard({ x: 200, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(rollTrapDetection).toHaveBeenCalledOnce();
    expect(h.actor.flags.trapDetected).toBe(true);
    expect(h.hidden).toBe(false);
    expect(triggerTrap).not.toHaveBeenCalled();
  });

  it("failed detection leaves the trap hidden and undetected", async () => {
    rollTrapDetection.mockResolvedValue({ detected: false });
    const h = makeHazard({ x: 200, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(h.actor.flags.trapDetected).toBeUndefined();
    expect(h.hidden).toBe(true);
  });

  it("overlap triggers once even when invoked twice concurrently", async () => {
    const h = makeHazard({ x: 100, y: 100 });
    const mover = makeMover([h]);
    await Promise.all([
      handleTrapTokenMove(mover, MOVE, base),
      handleTrapTokenMove(mover, MOVE, base),
    ]);
    expect(triggerTrap).toHaveBeenCalledOnce();
    expect(h.actor.flags.trapTriggered).toBe(true);
    expect(h.hidden).toBe(false);
  });

  it("disabled trap is marked triggered but does not attack", async () => {
    const h = makeHazard({ x: 100, y: 100, actorFlags: { trapDisabled: true } });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(triggerTrap).not.toHaveBeenCalled();
    expect(h.actor.flags.trapTriggered).toBe(true);
  });

  it("a walk-over trigger marks the hazard token spent (#754)", async () => {
    const h = makeHazard({ x: 100, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(h.flags.trapSpent).toBe(true);
  });

  it("detection alone does not mark the token spent (#754)", async () => {
    const h = makeHazard({ x: 200, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(h.flags.trapSpent).toBeUndefined();
  });

  it("skips an already-triggered trap", async () => {
    const h = makeHazard({ x: 100, y: 100, actorFlags: { trapTriggered: true } });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(triggerTrap).not.toHaveBeenCalled();
    expect(rollTrapDetection).not.toHaveBeenCalled();
  });

  it("releases the lock if the trigger throws", async () => {
    triggerTrap.mockRejectedValueOnce(new Error("boom"));
    const h = makeHazard({ x: 100, y: 100 });
    h.actor.flags.trapTriggered = false;
    await expect(handleTrapTokenMove(makeMover([h]), MOVE, base)).rejects.toThrow("boom");
    h.actor.flags.trapTriggered = false;
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(triggerTrap).toHaveBeenCalledTimes(2);
  });

  it("announces a successful detection by seeker and trap name", async () => {
    const h = makeHazard({ x: 200, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(announce).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith("PF2EDC.Dungeon.Trap.DetectedChat", {
      name: "Valeros",
      trap: "Spiked Pit",
    });
  });

  it("failed detection announces nothing", async () => {
    rollTrapDetection.mockResolvedValue({ detected: false });
    const h = makeHazard({ x: 200, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(announce).not.toHaveBeenCalled();
  });

  it("announces a trap being set off", async () => {
    const h = makeHazard({ x: 100, y: 100 });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(announce).toHaveBeenCalledWith("PF2EDC.Dungeon.Trap.TriggeredChat", {
      name: "Valeros",
      trap: "Spiked Pit",
    });
  });

  it("a disabled trap sets nothing off, so no announcement", async () => {
    const h = makeHazard({ x: 100, y: 100, actorFlags: { trapDisabled: true } });
    await handleTrapTokenMove(makeMover([h]), MOVE, base);
    expect(announce).not.toHaveBeenCalled();
  });
});
