import { describe, it, expect, vi, afterEach } from "vitest";
import {
  walkTokenThroughSteps,
  movementStepDelayMs,
  MOVEMENT_STEP_DELAY_MS,
  followerStepDelayMs,
  FOLLOWER_STEP_DELAY_MS,
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

describe("followerStepDelayMs (#689)", () => {
  it("falls back to 150 when settings are unavailable", () => {
    delete globalThis.game;
    expect(FOLLOWER_STEP_DELAY_MS).toBe(150);
    expect(followerStepDelayMs()).toBe(150);
  });

  it("falls back to 150 when the value is invalid", () => {
    globalThis.game = { settings: { get: () => "fast" } };
    expect(followerStepDelayMs()).toBe(150);
    globalThis.game = { settings: { get: () => -5 } };
    expect(followerStepDelayMs()).toBe(150);
  });

  it("reads its own world setting, not movementStepDelayMs", () => {
    globalThis.game = {
      settings: { get: (_m, key) => (key === "followerStepDelayMs" ? 220 : 999) },
    };
    expect(followerStepDelayMs()).toBe(220);
  });
});

describe("walkTokenThroughSteps delayMs (#689)", () => {
  const steps = [{ gx: 1, gy: 0 }, { gx: 2, gy: 0 }, { gx: 3, gy: 0 }];

  it("uses the explicit delayMs when given", async () => {
    vi.useFakeTimers();
    globalThis.game = { settings: { get: () => 777 } };
    const spy = vi.spyOn(globalThis, "setTimeout");
    const token = { update: vi.fn(async () => {}) };
    const p = walkTokenThroughSteps(token, steps, 50, undefined, 123);
    await vi.runAllTimersAsync();
    await p;
    expect(spy.mock.calls.filter((c) => c[1] === 123)).toHaveLength(2);
    expect(spy.mock.calls.filter((c) => c[1] === 777)).toHaveLength(0);
  });

  it("uses movementStepDelayMs when delayMs is undefined or null", async () => {
    vi.useFakeTimers();
    globalThis.game = { settings: { get: () => 777 } };
    const spy = vi.spyOn(globalThis, "setTimeout");
    for (const d of [undefined, null]) {
      const token = { update: vi.fn(async () => {}) };
      const p = walkTokenThroughSteps(token, steps, 50, undefined, d);
      await vi.runAllTimersAsync();
      await p;
    }
    expect(spy.mock.calls.filter((c) => c[1] === 777)).toHaveLength(4);
  });
});
