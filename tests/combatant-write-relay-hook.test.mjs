import { describe, it, expect, vi } from "vitest";
import {
  onPreUpdateCombatantRelay, handleCombatantFlagRelay, registerCombatantWriteRelay,
} from "../scripts/combatant-write-relay.mjs";
import { preserveCombatantFlagNamespaces } from "../scripts/combatant-flag-guard.mjs";

const NS = "pf2e-auto-action-tracker";
const SOCKET = "module.pf2e-dungeon-crawl";

function mkGame({ isGM = false, activeGM = {}, users = {} } = {}) {
  return {
    user: { id: "u1", isGM },
    users: { activeGM, get: (id) => users[id] },
    socket: { emit: vi.fn(), on: vi.fn() },
    combats: { get: vi.fn() },
  };
}
const mkCombatant = () => ({ id: "cb", parent: { id: "k" }, updateSource: vi.fn(), setFlag: vi.fn(async () => {}) });
const qChanges = { _id: "cb", flags: { [NS]: { pendingDamageQueue: ["m1"] } } };
const log = () => ({ error: vi.fn(), debug: vi.fn() });

describe("onPreUpdateCombatantRelay", () => {
  it("relays a player queue write: local updateSource, one emit, returns false", () => {
    const game = mkGame(); const c = mkCombatant();
    expect(onPreUpdateCombatantRelay(c, qChanges, {}, "u1", { game, log: log() })).toBe(false);
    expect(c.updateSource).toHaveBeenCalledWith({ flags: { [NS]: { pendingDamageQueue: ["m1"] } } });
    expect(game.socket.emit).toHaveBeenCalledTimes(1);
    expect(game.socket.emit).toHaveBeenCalledWith(SOCKET, {
      type: "combatantFlagRelay", combatId: "k", combatantId: "cb",
      flagKey: "pendingDamageQueue", value: ["m1"], userId: "u1",
    });
  });
  it("ignores updates made by another user", () => {
    const game = mkGame(); const c = mkCombatant();
    expect(onPreUpdateCombatantRelay(c, qChanges, {}, "u2", { game, log: log() })).toBeUndefined();
    expect(c.updateSource).not.toHaveBeenCalled();
    expect(game.socket.emit).not.toHaveBeenCalled();
  });
  it("ignores GM clients", () => {
    const game = mkGame({ isGM: true }); const c = mkCombatant();
    expect(onPreUpdateCombatantRelay(c, qChanges, {}, "u1", { game, log: log() })).toBeUndefined();
    expect(game.socket.emit).not.toHaveBeenCalled();
  });
  it("ignores unrelated and mixed writes (nothing applied locally either)", () => {
    for (const ch of [
      { initiative: 3 },
      { flags: { [NS]: { pendingDamageQueue: [] }, "pf2e-dungeon-crawl": { agentControlled: false } } },
      { flags: { [NS]: { pendingDamageQueue: "bad" } } },
      { flags: { [NS]: { pendingDamageQueue: [], log: [] } } },
    ]) {
      const game = mkGame(); const c = mkCombatant();
      expect(onPreUpdateCombatantRelay(c, ch, {}, "u1", { game, log: log() })).toBeUndefined();
      expect(c.updateSource).not.toHaveBeenCalled();
      expect(game.socket.emit).not.toHaveBeenCalled();
    }
  });
  it("applies locally but does not emit when no GM is online", () => {
    const game = mkGame({ activeGM: null }); const c = mkCombatant(); const l = log();
    expect(onPreUpdateCombatantRelay(c, qChanges, {}, "u1", { game, log: l })).toBe(false);
    expect(c.updateSource).toHaveBeenCalled();
    expect(game.socket.emit).not.toHaveBeenCalled();
    expect(l.debug).toHaveBeenCalled();
  });
  it("lets the original update proceed when anything throws", () => {
    const game = mkGame(); const c = mkCombatant(); const l = log();
    c.updateSource.mockImplementation(() => { throw new Error("boom"); });
    expect(onPreUpdateCombatantRelay(c, qChanges, {}, "u1", { game, log: l })).toBeUndefined();
    expect(l.error).toHaveBeenCalled();
    expect(game.socket.emit).not.toHaveBeenCalled();
  });
  it("lets the update proceed when emit throws", () => {
    const game = mkGame(); const c = mkCombatant(); const l = log();
    game.socket.emit.mockImplementation(() => { throw new Error("net"); });
    expect(onPreUpdateCombatantRelay(c, qChanges, {}, "u1", { game, log: l })).toBeUndefined();
    expect(l.error).toHaveBeenCalled();
  });
});

describe("handleCombatantFlagRelay", () => {
  const msg = { type: "combatantFlagRelay", combatId: "k", combatantId: "cb", flagKey: "pendingDamageQueue", value: ["m1"], userId: "u1" };
  function setup({ self = true, owner = true } = {}) {
    const c = mkCombatant();
    c.actor = { testUserPermission: (u, lvl) => owner && lvl === "OWNER" };
    const game = mkGame({ activeGM: { isSelf: self }, users: { u1: { id: "u1" } } });
    game.combats.get = (id) => (id === "k" ? { combatants: { get: (i) => (i === "cb" ? c : undefined) } } : undefined);
    return { c, game };
  }
  it("applies a valid owner message on the active GM client", async () => {
    const { c, game } = setup();
    expect(await handleCombatantFlagRelay(msg, { game, log: log() })).toBe(true);
    expect(c.setFlag).toHaveBeenCalledWith(NS, "pendingDamageQueue", ["m1"]);
  });
  it("does nothing when this client is not the active GM", async () => {
    const { c, game } = setup({ self: false });
    expect(await handleCombatantFlagRelay(msg, { game, log: log() })).toBe(false);
    expect(c.setFlag).not.toHaveBeenCalled();
  });
  it("does nothing when there is no active GM", async () => {
    const { c, game } = setup(); game.users.activeGM = null;
    expect(await handleCombatantFlagRelay(msg, { game, log: log() })).toBe(false);
    expect(c.setFlag).not.toHaveBeenCalled();
  });
  it("rejects a non-owner sender, unlisted key, and bad value", async () => {
    for (const [m, o] of [[msg, { owner: false }], [{ ...msg, flagKey: "log" }, {}], [{ ...msg, value: [1] }, {}], [null, {}]]) {
      const { c, game } = setup(o);
      expect(await handleCombatantFlagRelay(m, { game, log: log() })).toBe(false);
      expect(c.setFlag).not.toHaveBeenCalled();
    }
  });
  it("is idempotent for a repeated message", async () => {
    const { c, game } = setup();
    await handleCombatantFlagRelay(msg, { game, log: log() });
    await handleCombatantFlagRelay(msg, { game, log: log() });
    expect(c.setFlag).toHaveBeenCalledTimes(2);
    expect(c.setFlag.mock.calls[0]).toEqual(c.setFlag.mock.calls[1]);
  });
  it("returns false (does not throw) when setFlag rejects", async () => {
    const { c, game } = setup(); c.setFlag.mockRejectedValue(new Error("x"));
    expect(await handleCombatantFlagRelay(msg, { game, log: log() })).toBe(false);
  });
});

describe("registerCombatantWriteRelay", () => {
  it("only dispatches combatantFlagRelay messages", () => {
    const game = mkGame();
    globalThis.game = game;
    registerCombatantWriteRelay();
    expect(game.socket.on).toHaveBeenCalledWith(SOCKET, expect.any(Function));
    const cb = game.socket.on.mock.calls[0][1];
    expect(() => { cb({ type: "other" }); cb(null); }).not.toThrow();
    delete globalThis.game;
  });
});

describe("registerCombatantWriteRelay sender authentication", () => {
  const msg = { type: "combatantFlagRelay", combatId: "k", combatantId: "cb", flagKey: "pendingDamageQueue", value: ["m1"] };
  function setup() {
    const c = mkCombatant();
    // only u1 owns the actor
    c.actor = { testUserPermission: (u, lvl) => u.id === "u1" && lvl === "OWNER" };
    const game = mkGame({ activeGM: { isSelf: true }, users: { u1: { id: "u1" }, u2: { id: "u2" } } });
    game.combats.get = (id) => (id === "k" ? { combatants: { get: (i) => (i === "cb" ? c : undefined) } } : undefined);
    globalThis.game = game;
    registerCombatantWriteRelay();
    return { c, cb: game.socket.on.mock.calls[0][1] };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  it("uses the real sender id for ownership (no msg.userId)", async () => {
    const { c, cb } = setup();
    cb({ ...msg }, "u1"); await flush();
    expect(c.setFlag).toHaveBeenCalledWith(NS, "pendingDamageQueue", ["m1"]);
    delete globalThis.game;
  });
  it("drops a spoofed msg.userId that differs from the sender", async () => {
    const { c, cb } = setup();
    cb({ ...msg, userId: "u1" }, "u2"); await flush();
    expect(c.setFlag).not.toHaveBeenCalled();
    delete globalThis.game;
  });
  it("drops a message with no sender id", async () => {
    const { c, cb } = setup();
    cb({ ...msg, userId: "u1" }); await flush();
    expect(c.setFlag).not.toHaveBeenCalled();
    delete globalThis.game;
  });
  it("accepts a matching msg.userId", async () => {
    const { c, cb } = setup();
    cb({ ...msg, userId: "u1" }, "u1"); await flush();
    expect(c.setFlag).toHaveBeenCalledTimes(1);
    delete globalThis.game;
  });
});

describe("ordering vs the #1212 guard", () => {
  const existing = () => ({ "pf2e-dungeon-crawl": { agentControlled: true }, [NS]: { log: [] } });
  it("still restores namespaces for a non-relayed non-recursive update", () => {
    const changes = { flags: { [NS]: { log: [1] } } };
    const game = mkGame(); const c = mkCombatant();
    expect(onPreUpdateCombatantRelay(c, changes, { diff: false, recursive: false }, "u1", { game, log: log() })).toBeUndefined();
    preserveCombatantFlagNamespaces(existing(), changes, { diff: false, recursive: false });
    expect(changes.flags["pf2e-dungeon-crawl"]).toEqual({ agentControlled: true });
  });
  it("returns false for a relayed payload so a runner stopping at false never reaches the guard", () => {
    const game = mkGame(); const c = mkCombatant();
    const guard = vi.fn();
    const handlers = [(...a) => onPreUpdateCombatantRelay(...a, { game, log: log() }), guard];
    for (const h of handlers) if (h(c, qChanges, { diff: false, recursive: false }, "u1") === false) break;
    expect(guard).not.toHaveBeenCalled();
  });
});
