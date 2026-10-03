import { describe, it, expect, vi, afterEach } from "vitest";
import {
  walkTokenThroughSteps,
  movementStepDelayMs,
  MOVEMENT_STEP_DELAY_MS,
} from "../scripts/token-walk.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete globalThis.game;
});

describe("movementStepDelayMs (#610)", () => {
  it("falls back to the default when settings are unavailable", () => {
    delete globalThis.game;
    expect(movementStepDelayMs()).toBe(MOVEMENT_STEP_DELAY_MS);
  });

  it("reads the world setting", () => {
    globalThis.game = { settings: { get: () => 250 } };
    expect(movementStepDelayMs()).toBe(250);
  });
});

describe("walkTokenThroughSteps (#610)", () => {
  it("writes each cell with teleport:true, pausing between but not after hops", async () => {
    vi.useFakeTimers();
    globalThis.game = { settings: { get: () => 100 } };
    const spy = vi.spyOn(globalThis, "setTimeout");
    const token = { update: vi.fn(async () => {}) };
    const p = walkTokenThroughSteps(
      token,
      [{ gx: 1, gy: 0 }, { gx: 2, gy: 1 }, { gx: 3, gy: 1 }],
      50,
    );
    await vi.runAllTimersAsync();
    await p;
    expect(token.update.mock.calls).toEqual([
      [{ x: 50, y: 0 }, { teleport: true }],
      [{ x: 100, y: 50 }, { teleport: true }],
      [{ x: 150, y: 50 }, { teleport: true }],
    ]);
    expect(spy.mock.calls.filter((c) => c[1] === 100)).toHaveLength(2);
  });

  it("calls onHop before and after every write", async () => {
    globalThis.game = { settings: { get: () => 0 } };
    const order = [];
    const token = { update: vi.fn(async () => order.push("write")) };
    await walkTokenThroughSteps(token, [{ gx: 1, gy: 0 }, { gx: 2, gy: 0 }], 50, () =>
      order.push("hop"),
    );
    expect(order).toEqual(["hop", "write", "hop", "hop", "write", "hop"]);
  });

  it("does nothing for an empty step list", async () => {
    const token = { update: vi.fn() };
    await walkTokenThroughSteps(token, [], 50);
    expect(token.update).not.toHaveBeenCalled();
  });
});
