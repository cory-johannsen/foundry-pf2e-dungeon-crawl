/**
 * Generator subjects for the themed room-feature art (#750): one image per
 * room theme and kind, written to assets/room-features/<theme>/<kind>.webp.
 * Imported into generate-token-art.mjs's ALL list, so the generator's
 * ComfyUI-first / OpenRouter-fallback backends and skip-if-exists behavior
 * apply unchanged. Ids are `rf-<theme>-<kind>`, e.g.
 *   node tools/generate-token-art.mjs rf-undead-treasure
 * Then cut each result out with tools/cutout-room-feature-art.py (rembg).
 * No apostrophes in any string here; the generator builds JS strings from them.
 */
import { ROOM_FEATURE_ART_THEMES, ROOM_FEATURE_ART_KINDS } from '../scripts/room-feature-art.mjs';

/** How each theme dresses an object: materials, colors and details. */
const THEME_FLAVOR = {
  aberration: 'fleshy purple tissue, pulsing veins, many small watching eyes, slick tentacle trim',
  beast: 'rough hide, bone and antler, claw marks, lashed wood, fur trim',
  construct: 'riveted brass and iron plates, gears, cogs and pistons, glowing seams',
  dragon: 'gold and crimson scale-pattern plating, claw-shaped handles and fittings, ember glow in the seams',
  elemental: 'carved stone with inlaid flame, ice crystal and lightning accents',
  fiend: 'black iron, spikes and horns, hellfire glow, infernal sigils',
  plant: 'living wood, thick vines, moss, leaves and glowing flowers',
  undead: 'old bone, grave stone, cobwebs, pale green ghostlight, tattered cloth',
};

/** The object each kind shows. DOOR_SUBJECT is the one line to edit if the
 * door image viewpoint or shape needs to change. */
export const DOOR_SUBJECT = 'a single heavy wooden dungeon door slab standing alone, straight-on view, vertical planks with iron bands, hinges and a handle, no wall, no stone archway, no doorframe';
const KIND_SUBJECT = {
  door: DOOR_SUBJECT,
  treasure: 'a closed treasure chest with a lid and a lock, seen from a three-quarter angle',
  puzzle: 'a small free-standing puzzle device, a compact cluster of rotating dials and sliding blocks around a keyhole, seen from a three-quarter angle',
  skill_challenge: 'a tall trial standard, a pole topped with a banner and crossed tools, seen from a three-quarter angle',
};

const AVOID = 'floor, ground, shadow on the ground, pedestal, base, plinth, frame, border, circle, ring, '
  + 'scenery, room, wall, people, creatures, faces, heads, monsters, hands, text, letters, square plate, panel';

export const ROOM_FEATURE_ART = ROOM_FEATURE_ART_THEMES.flatMap((theme) =>
  ROOM_FEATURE_ART_KINDS.map((kind) => ({
    id: `rf-${theme}-${kind}`,
    file: kind,
    dir: `assets/room-features/${theme}`,
    icon: true,
    prompt: `${KIND_SUBJECT[kind]}, styled as a ${theme} dungeon object with ${THEME_FLAVOR[theme]}, `
      + 'an inanimate object only, no creature and no face, the single object centered and filling the picture, plain empty background',
    avoid: AVOID,
  })),
);
