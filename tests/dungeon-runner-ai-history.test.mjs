import { describe, it, expect, vi } from "vitest";
import { ensureAiHistoryId, abandonRun, getRunState } from "../scripts/dungeon-runner.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

function fakeSettingsRef(initial) {
  let value = initial;
  const set = vi.fn(async (_mod, _key, v) => {
    value = v;
  });
  return { get: (_mod, key) => (key === "dungeonRuns" ? value : undefined), set };
}

describe("ensureAiHistoryId (#953)", () => {
  it("generates and persists a new id for a run with none yet, keeping the rest of the state", async () => {
    const settingsRef = fakeSettingsRef({ scene1: { rooms: {}, seed: "s" }, other: { seed: "o" } });
    const id = await ensureAiHistoryId("scene1", { settingsRef, makeId: () => "gen123" });
    expect(id).toBe("gen123");
    const all = settingsRef.get(MODULE_ID, "dungeonRuns");
    expect(all.scene1).toEqual({ rooms: {}, seed: "s", aiHistoryId: "gen123" });
    expect(all.other).toEqual({ seed: "o" });
  });

  it("returns the existing id without writing", async () => {
    const settingsRef = fakeSettingsRef({ scene1: { aiHistoryId: "existing" } });
    expect(await ensureAiHistoryId("scene1", { settingsRef, makeId: () => "x" })).toBe("existing");
    expect(settingsRef.set).not.toHaveBeenCalled();
  });

  it("returns null for a scene with no run", async () => {
    const settingsRef = fakeSettingsRef({});
    expect(await ensureAiHistoryId("scene1", { settingsRef })).toBeNull();
    expect(settingsRef.set).not.toHaveBeenCalled();
  });

  it("throws when the id cannot be persisted (the archive is then skipped)", async () => {
    const settingsRef = fakeSettingsRef({ scene1: {} });
    settingsRef.set.mockRejectedValueOnce(new Error("not GM"));
    await expect(ensureAiHistoryId("scene1", { settingsRef, makeId: () => "x" })).rejects.toThrow("not GM");
  });

  it("gives a new run its own id", async () => {
    const settingsRef = fakeSettingsRef({ a: {}, b: {} });
    let n = 0;
    const makeId = () => `id${++n}`;
    expect(await ensureAiHistoryId("a", { settingsRef, makeId })).toBe("id1");
    expect(await ensureAiHistoryId("b", { settingsRef, makeId })).toBe("id2");
  });
});

describe("abandonRun AI history cleanup (#953)", () => {
  it("deletes the abandoned run's journals by its aiHistoryId and scene id, then removes the run", async () => {
    const settingsRef = fakeSettingsRef({ scene1: { aiHistoryId: "abc123", completed: false } });
    const deleteHistoryJournals = vi.fn(async () => 2);
    await abandonRun({ sceneId: "scene1" }, { settingsRef, deleteHistoryJournals });
    expect(deleteHistoryJournals).toHaveBeenCalledWith({ historyId: "abc123", sceneId: "scene1" });
    expect(getRunState("scene1", { settingsRef })).toBeNull();
  });

  it("still sweeps by scene id when the run never stored an aiHistoryId", async () => {
    const settingsRef = fakeSettingsRef({ scene1: { completed: false } });
    const deleteHistoryJournals = vi.fn(async () => 0);
    await abandonRun({ sceneId: "scene1" }, { settingsRef, deleteHistoryJournals });
    expect(deleteHistoryJournals).toHaveBeenCalledWith({ historyId: null, sceneId: "scene1" });
  });

  it("keeps a completed run's journals", async () => {
    const settingsRef = fakeSettingsRef({ scene1: { aiHistoryId: "abc123", completed: true } });
    const deleteHistoryJournals = vi.fn();
    await abandonRun({ sceneId: "scene1" }, { settingsRef, deleteHistoryJournals });
    expect(deleteHistoryJournals).not.toHaveBeenCalled();
    expect(getRunState("scene1", { settingsRef })).toBeNull();
  });

  it("never lets a failing journal deletion block the abandon", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const settingsRef = fakeSettingsRef({ scene1: { aiHistoryId: "abc123" } });
    const deleteHistoryJournals = vi.fn(async () => {
      throw new Error("boom");
    });
    await abandonRun({ sceneId: "scene1" }, { settingsRef, deleteHistoryJournals });
    expect(getRunState("scene1", { settingsRef })).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("does nothing for a scene with no run", async () => {
    const settingsRef = fakeSettingsRef({});
    const deleteHistoryJournals = vi.fn();
    await abandonRun({ sceneId: "nope" }, { settingsRef, deleteHistoryJournals });
    expect(deleteHistoryJournals).not.toHaveBeenCalled();
    expect(settingsRef.set).not.toHaveBeenCalled();
  });

  it("deletes real journals through the default deleter (GM client)", async () => {
    const del = vi.fn(async () => {});
    const journal = { name: "x", folder: null, getFlag: (_m, k) => (k === "aiHistory" ? { historyId: "abc123", kind: "public" } : undefined), delete: del };
    const keep = { name: "y", folder: null, getFlag: () => undefined, delete: vi.fn() };
    globalThis.game = { journal: { contents: [journal, keep] }, folders: { get: () => undefined } };
    try {
      const settingsRef = fakeSettingsRef({ scene1: { aiHistoryId: "abc123" } });
      await abandonRun({ sceneId: "scene1" }, { settingsRef });
      expect(del).toHaveBeenCalled();
      expect(keep.delete).not.toHaveBeenCalled();
    } finally {
      delete globalThis.game;
    }
  });
});
