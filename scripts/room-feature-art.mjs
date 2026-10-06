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
export const ROOM_FEATURE_ART_BASE_KINDS = ["door", "treasure", "puzzle", "skill_challenge"];
// #764: one state variant per base kind, ignoring floor variant (user decision
// 2026-10-05) -- a locked door or a used/solved token looks the same across
// a theme's own 3 floor sub-styles.
export const ROOM_FEATURE_ART_STATE_KINDS = [
  "door_locked", "treasure_used", "puzzle_used", "skill_challenge_used",
];
export const ROOM_FEATURE_ART_KINDS = [...ROOM_FEATURE_ART_BASE_KINDS, ...ROOM_FEATURE_ART_STATE_KINDS];
export const ROOM_FEATURE_ART_DIR = `modules/${MODULE_ID}/assets/room-features`;

/**
 * Module-relative path of the themed image, or null when the manifest does
 * not list that theme/kind/variant (or either name is unknown).
 *
 * #764: the manifest's per-theme value is `{kind: [variants]}` -- which
 * floor-variant indices (0, 1, 2) exist for that kind. `variant` defaults to
 * 0; an unlisted requested variant falls back to variant 0 before giving up
 * and returning null. Variant 0's file stays unsuffixed (`<kind>.webp`);
 * variant 1/2 add a `-<variant>` suffix. State kinds only ever have variant 0.
 */
export function roomFeatureArtPath({ theme, kind, variant = 0, manifest } = {}) {
  if (!ROOM_FEATURE_ART_THEMES.includes(theme)) return null;
  if (!ROOM_FEATURE_ART_KINDS.includes(kind)) return null;
  const variants = manifest?.[theme]?.[kind];
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const resolved = variants.includes(variant) ? variant : (variants.includes(0) ? 0 : null);
  if (resolved === null) return null;
  const suffix = resolved === 0 ? "" : `-${resolved}`;
  return `${ROOM_FEATURE_ART_DIR}/${theme}/${kind}${suffix}.webp`;
}

/** Foundry wall `animation` defaults for a themed door. The live spike chose
 * `swing` (see the spec's Spike result); `texture` is always the themed image. */
export const DOOR_ANIMATION = { type: "swing" };

/** Pixel width of every shipped door strip (assets/room-features/<theme>/door.webp).
 * Foundry draws a wall texture at the wall's length horizontally but scales it
 * vertically by gridSize / `flags.core.textureGridSize` (default 200), so a
 * strip keeps its aspect only when that flag is the texture width per square of
 * door length. */
export const DOOR_TEXTURE_WIDTH_PX = 1200;

/** The wall `animation` object for a themed door, or null with no art. */
export function doorAnimationFor(art) {
  return art ? { ...DOOR_ANIMATION, texture: art } : null;
}
