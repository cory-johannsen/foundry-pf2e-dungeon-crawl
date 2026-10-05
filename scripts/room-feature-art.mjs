/**
 * Themed art for doors and room-feature prop tokens (#750). Pure lookup over
 * `data/room-feature-art.json` (the manifest of which theme/kind images
 * exist) — no Foundry deps, same pure/data split `creature-art.mjs` keeps.
 * The manifest, not the filesystem, decides what exists: the runtime cannot
 * check files, and a missing entry is always a silent fallback, never an error.
 */
const MODULE_ID = "pf2e-dungeon-crawl";

export const ROOM_FEATURE_ART_THEMES = [
  "aberration", "beast", "construct", "dragon",
  "elemental", "fiend", "plant", "undead",
];
export const ROOM_FEATURE_ART_KINDS = ["door", "treasure", "puzzle", "skill_challenge"];
export const ROOM_FEATURE_ART_DIR = `modules/${MODULE_ID}/assets/room-features`;

/** Module-relative path of the themed image, or null when the manifest does
 * not list that theme/kind (or either name is unknown). */
export function roomFeatureArtPath({ theme, kind, manifest } = {}) {
  if (!ROOM_FEATURE_ART_THEMES.includes(theme)) return null;
  if (!ROOM_FEATURE_ART_KINDS.includes(kind)) return null;
  const kinds = manifest?.[theme];
  if (!Array.isArray(kinds) || !kinds.includes(kind)) return null;
  return `${ROOM_FEATURE_ART_DIR}/${theme}/${kind}.webp`;
}

/** Foundry wall `animation` defaults for a themed door. Task 3's live spike
 * fixes the final values; `texture` is always the themed image. */
export const DOOR_ANIMATION = { type: "swing" };

/** The wall `animation` object for a themed door, or null with no art. */
export function doorAnimationFor(art) {
  return art ? { ...DOOR_ANIMATION, texture: art } : null;
}
