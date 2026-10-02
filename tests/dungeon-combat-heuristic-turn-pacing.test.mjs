import { describe, it, expect, vi, afterEach } from "vitest";
import { playHeuristicTurn } from "../scripts/dungeon-combat.mjs";

const GRID_SIZE = 100;

// A failing assertion mid-test must not leak fake timers or a setTimeout
// spy into the next test.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function installFoundryStubs() {
  globalThis.game = {
    combats: { has: () => true },
  };
}

function makeCombatant({ id, x, y, disposition = -1 } = {}) {
  return {
    id,
    isDefeated: false,
    token: { x, y, disposition },
  };
}

function makeCombat({ combatants = [] } = {}) {
  return {
    id: "combat-1",
    combatant: combatants[0] ?? null,
    combatants,
    scene: { grid: { size: GRID_SIZE, distance: 5 } },
    nextTurn: vi.fn(),
  };
}

describe("playHeuristicTurn action pacing (#479)", () => {
  it("waits between moving and striking when there's a target to act against", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, disposition: -1 });
    const target = makeCombatant({ id: "target", x: GRID_SIZE, y: 0, disposition: 1 });
    const combat = makeCombat({ combatants: [mover, target] });
    const move = vi.fn().mockResolvedValue("moved");
    const strike = vi.fn().mockResolvedValue(undefined);
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const turnPromise = playHeuristicTurn(combat, mover, { move, strike });
    await vi.runAllTimersAsync();
    await turnPromise;

    expect(move).toHaveBeenCalledWith(combat, mover, target, 1);
    expect(strike).toHaveBeenCalledWith(combat, mover, target);
    // move must fully resolve, then the pacing delay, then strike -- not
    // both fired back-to-back with the delay merely racing alongside them.
    expect(move.mock.invocationCallOrder[0]).toBeLessThan(setTimeoutSpy.mock.invocationCallOrder[0]);
    expect(setTimeoutSpy.mock.invocationCallOrder[0]).toBeLessThan(strike.mock.invocationCallOrder[0]);
    const paceDelayCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 600);
    expect(paceDelayCalls).toHaveLength(1);
    expect(combat.nextTurn).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("never waits or strikes when there's no opponent at all", async () => {
    installFoundryStubs();
    const mover = makeCombatant({ id: "mover", x: 0, y: 0 });
    const combat = makeCombat({ combatants: [mover] });
    const move = vi.fn();
    const strike = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await playHeuristicTurn(combat, mover, { move, strike });

    expect(move).not.toHaveBeenCalled();
    expect(strike).not.toHaveBeenCalled();
    expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 600)).toHaveLength(0);
    expect(combat.nextTurn).toHaveBeenCalled();
  });
});
