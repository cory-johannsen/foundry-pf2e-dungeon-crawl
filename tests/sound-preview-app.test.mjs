// #600: SoundPreviewApp -- GM-only preview menu. Guards that a preview click
// never broadcasts to players, and that the menu is registered GM-restricted.
import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("../scripts/audio.mjs", () => ({ playSound: vi.fn() }));

const priorFoundry = globalThis.foundry;
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (Base) => Base } },
};

const { SoundPreviewApp } = await import("../scripts/ui/sound-preview-app.mjs");
const { playSound } = await import("../scripts/audio.mjs");
const { soundPreviewEntries, DUNGEON_SOUND_FILES } = await import(
  "../scripts/dungeon-sound.mjs"
);

afterAll(() => {
  globalThis.foundry = priorFoundry;
});

describe("SoundPreviewApp", () => {
  const path = "modules/pf2e-dungeon-crawl/assets/sounds/door-open.ogg";

  it("play action plays the clicked path locally, never broadcast to players", () => {
    playSound.mockClear();
    SoundPreviewApp.DEFAULT_OPTIONS.actions.play({}, { dataset: { soundPath: path } });
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith(path, { broadcast: false });
  });

  it("play action does nothing without a sound path", () => {
    playSound.mockClear();
    SoundPreviewApp.DEFAULT_OPTIONS.actions.play({}, { dataset: {} });
    SoundPreviewApp.DEFAULT_OPTIONS.actions.play({}, undefined);
    expect(playSound).not.toHaveBeenCalled();
  });

  it("_prepareContext lists every previewable sound", async () => {
    const ctx = await new SoundPreviewApp()._prepareContext();
    expect(ctx).toEqual({ sounds: soundPreviewEntries() });
    expect(ctx.sounds).toHaveLength(Object.keys(DUNGEON_SOUND_FILES).length + 2);
  });
});

describe("settings-menu registration", () => {
  it("module.mjs registers the soundPreview menu GM-restricted with SoundPreviewApp", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../scripts/module.mjs", import.meta.url)),
      "utf8",
    );
    const start = src.indexOf('registerMenu(MODULE_ID, "soundPreview"');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("});", start));
    expect(block).toContain("restricted: true");
    expect(block).toContain("type: SoundPreviewApp");
  });
});
