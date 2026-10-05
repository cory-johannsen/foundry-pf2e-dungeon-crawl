import { soundPreviewEntries } from "../dungeon-sound.mjs";
import { playSound } from "../audio.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** GM-facing settings-menu form (#600) listing every dungeon-crawl sound
 * effect with a play button, so a GM can audition them without triggering
 * the real game event each one is tied to. Mirrors DungeonApp's own
 * ApplicationV2/HandlebarsApplicationMixin shape (scripts/ui/dungeon-app.mjs)
 * -- the established pattern for this module's custom UI. */
export class SoundPreviewApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "pf2edc-sound-preview-app",
    tag: "section",
    window: { title: "PF2EDC.SoundPreview.Title", icon: "fa-solid fa-volume-high" },
    position: { width: 360, height: "auto" },
    actions: {
      play: SoundPreviewApp.#onPlay,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/sound-preview.hbs` },
  };

  async _prepareContext() {
    return { sounds: soundPreviewEntries() };
  }

  /** #600: broadcast:false so auditioning a sound as GM doesn't also play
   * it for every connected player -- playSound's own default is
   * broadcast:true, meant for real in-play triggers, not previewing. */
  static #onPlay(event, target) {
    const path = target?.dataset?.soundPath;
    if (!path) return;
    playSound(path, { broadcast: false });
  }
}
