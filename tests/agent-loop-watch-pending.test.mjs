import { describe, it, expect } from "vitest";
import { keyForPending, diffPending } from "../tools/agent-loop/watch-pending.mjs";

const trapEntry = {
  kind: "trap",
  sceneId: "scene-1",
  actorId: "trap1",
  name: "Scythe Blades",
};
const narrativeEntry = {
  kind: "narrative",
  sceneId: "scene-1",
  roomId: "room-1",
  archetype: "lore",
  name: "The Last Warden's Oath",
};

describe("keyForPending", () => {
  it("keys a trap entry by kind, sceneId, and actorId", () => {
    expect(keyForPending(trapEntry)).toBe("trap:scene-1:trap1");
  });

  it("keys a non-trap entry by kind, sceneId, and roomId", () => {
    expect(keyForPending(narrativeEntry)).toBe(
      "narrative:scene-1:room-1",
    );
  });
});

describe("diffPending", () => {
  it("reports every entry as new when nothing was previously seen", () => {
    const { newEntries, currentKeys } = diffPending(
      new Set(),
      [trapEntry, narrativeEntry],
    );
    expect(newEntries).toEqual([trapEntry, narrativeEntry]);
    expect(currentKeys).toEqual(new Set(["trap:scene-1:trap1", "narrative:scene-1:room-1"]));
  });

  it("does not re-report an entry already in the previous key set", () => {
    const previousKeys = new Set(["trap:scene-1:trap1"]);
    const { newEntries, currentKeys } = diffPending(previousKeys, [trapEntry]);
    expect(newEntries).toEqual([]);
    expect(currentKeys).toEqual(new Set(["trap:scene-1:trap1"]));
  });

  it("reports only the genuinely new entry when one of two was already seen", () => {
    const previousKeys = new Set(["trap:scene-1:trap1"]);
    const { newEntries, currentKeys } = diffPending(previousKeys, [
      trapEntry,
      narrativeEntry,
    ]);
    expect(newEntries).toEqual([narrativeEntry]);
    expect(currentKeys).toEqual(
      new Set(["trap:scene-1:trap1", "narrative:scene-1:room-1"]),
    );
  });

  it("treats zero pending entries as an empty, non-error result", () => {
    const { newEntries, currentKeys } = diffPending(new Set(["trap:scene-1:trap1"]), []);
    expect(newEntries).toEqual([]);
    expect(currentKeys).toEqual(new Set());
  });

  it("re-flags an entry as new if it resolves (disappears from a poll) and then reappears with the same key", () => {
    // Poll 1: entry present.
    const poll1 = diffPending(new Set(), [narrativeEntry]);
    expect(poll1.newEntries).toEqual([narrativeEntry]);
    // Poll 2: entry resolved — no longer returned by list_pending_customizations.
    const poll2 = diffPending(poll1.currentKeys, []);
    expect(poll2.currentKeys).toEqual(new Set());
    // Poll 3: the same room generates a fresh pending request later — reported
    // as new again, since poll 2's (now empty) key set no longer contains it.
    const poll3 = diffPending(poll2.currentKeys, [narrativeEntry]);
    expect(poll3.newEntries).toEqual([narrativeEntry]);
  });
});
