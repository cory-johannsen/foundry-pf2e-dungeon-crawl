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
    const paceDelayCalls = setTimeoutSpy.mock.calls.filter((call) => call[1] === 1200);
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
    expect(setTimeoutSpy.mock.calls.filter((call) => call[1] === 1200)).toHaveLength(0);
    expect(combat.nextTurn).toHaveBeenCalled();
  });

  async function runWith(settingsGet, deps = {}) {
    installFoundryStubs();
    if (settingsGet) globalThis.game.settings = { get: settingsGet };
    const mover = makeCombatant({ id: "mover", x: 0, y: 0, disposition: -1 });
    const target = makeCombatant({ id: "target", x: GRID_SIZE, y: 0, disposition: 1 });
    const combat = makeCombat({ combatants: [mover, target] });
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    const p = playHeuristicTurn(combat, mover, {
      move: vi.fn().mockResolvedValue("moved"),
      strike: vi.fn().mockResolvedValue(undefined),
      ...deps,
    });
    await vi.runAllTimersAsync();
    await p;
    return spy.mock.calls.map((c) => c[1]);
  }

  it("reads the actionPaceDelayMs world setting (#479)", async () => {
    const delays = await runWith((_m, key) => (key === "actionPaceDelayMs" ? 900 : undefined));
    expect(delays.filter((d) => d === 900)).toHaveLength(1);
  });

  it("falls back to 1200 when the setting is invalid or throws (#479)", async () => {
    expect((await runWith(() => -1)).filter((d) => d === 1200)).toHaveLength(1);
    vi.restoreAllMocks();
    expect(
      (await runWith(() => { throw new Error("x"); })).filter((d) => d === 1200),
    ).toHaveLength(1);
  });

  it("an injected delayMs still wins over the setting (#479)", async () => {
    const delays = await runWith(() => 900, { delayMs: 77 });
    expect(delays.filter((d) => d === 77)).toHaveLength(1);
    expect(delays).not.toContain(900);
  });
});
