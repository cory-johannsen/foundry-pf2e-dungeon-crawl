import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { doorSoundForWallTransition, playDoorSound } from "../scripts/dungeon-sound.mjs";

// #868: simulates module.mjs's updateWall hook sound reaction without a full
// Foundry Hooks harness; the hook is a thin call into these two exports.
function simulateUpdateWallSoundReaction(wall, changes) {
  if (changes.ds === undefined) return null;
  const sound = doorSoundForWallTransition(changes.ds, {
    hasRevealFlag: !!wall.getFlag("pf2e-dungeon-crawl", "dungeonRevealDoorForSlot"),
    hasStubFlag: !!wall.getFlag("pf2e-dungeon-crawl", "dungeonStubDoorFor"),
    hasGateFlag: !!wall.getFlag("pf2e-dungeon-crawl", "dungeonDoorToRoomId"),
  });
  if (sound) playDoorSound(sound, { broadcast: false });
  return sound;
}

function wall(flags) {
  return { getFlag: (_m, k) => flags[k] };
}

describe("#868 updateWall sound reaction (every client, no GM dependency)", () => {
  it("plays open for a reveal door, with broadcast disabled", () => {
    globalThis.foundry = { audio: { AudioHelper: { play: vi.fn(() => ({})) } } };
    const result = simulateUpdateWallSoundReaction(wall({ dungeonRevealDoorForSlot: "room1" }), { ds: 1 });
    expect(result).toBe("open");
    expect(globalThis.foundry.audio.AudioHelper.play).toHaveBeenCalledWith(
      expect.objectContaining({ src: expect.stringContaining("door-open") }),
      false,
    );
  });

  it("does nothing for a wall update with no ds change", () => {
    globalThis.foundry = { audio: { AudioHelper: { play: vi.fn(() => ({})) } } };
    const result = simulateUpdateWallSoundReaction(wall({ dungeonRevealDoorForSlot: "room1" }), {});
    expect(result).toBeNull();
    expect(globalThis.foundry.audio.AudioHelper.play).not.toHaveBeenCalled();
  });

  it("module.mjs records the previous ds in preUpdateWall and passes it on", () => {
    const src = readFileSync(new URL("../scripts/module.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/Hooks\.on\("preUpdateWall"/);
    expect(src).toMatch(/prevWallDs\.set\(wall\.id, wall\.ds\)/);
    expect(src).toMatch(/\}, prevDs\);/);
  });
});
