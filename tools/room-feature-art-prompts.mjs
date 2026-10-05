/**
 * Generator subjects for the themed room-feature art (#750): one image per
 * room theme and kind, written to assets/room-features/<theme>/<kind>.webp.
 * Imported into generate-token-art.mjs's ALL list, so the generator's
 * ComfyUI-first / OpenRouter-fallback backends and skip-if-exists behavior
 * apply unchanged. Ids are `rf-<theme>-<kind>`, e.g.
 *   node tools/generate-token-art.mjs rf-undead-treasure
 * Run each result through tools/make-bg-transparent.mjs afterwards.
 * No apostrophes in any string here; the generator builds JS strings from them.
 */
import { ROOM_FEATURE_ART_THEMES, ROOM_FEATURE_ART_KINDS } from '../scripts/room-feature-art.mjs';

/** How each theme dresses an object: materials, colors and details. */
const THEME_FLAVOR = {
  aberration: 'fleshy purple tissue, pulsing veins, many small watching eyes, slick tentacle trim',
  beast: 'rough hide, bone and antler, claw marks, lashed wood, fur trim',
  construct: 'riveted brass and iron plates, gears, cogs and pistons, glowing seams',
  dragon: 'gold scales, horn and claw ornament, ember glow, a dragon motif',
  elemental: 'swirling flame, ice and crystal, floating stone, crackling energy',
  fiend: 'black iron, spikes and horns, hellfire glow, infernal sigils',
  plant: 'living wood, thick vines, moss, leaves and glowing flowers',
  undead: 'old bone, grave stone, cobwebs, pale green ghostlight, tattered cloth',
};

/** The object each kind shows. DOOR_SUBJECT is the one line Task 3 may edit
 * once the live spike has fixed the door image viewpoint and shape. */
export const DOOR_SUBJECT = 'a single heavy dungeon door leaf seen from directly above, a long flat horizontal plank door with iron bands, hinges at one end and a handle at the other';
const KIND_SUBJECT = {
  door: DOOR_SUBJECT,
  treasure: 'a closed treasure chest with a lid and a lock, seen from a three-quarter angle',
  puzzle: 'an intricate puzzle mechanism with rotating dials, sliding tiles and a keyhole, seen from a three-quarter angle',
  skill_challenge: 'a tall trial standard, a pole topped with a banner and crossed tools, seen from a three-quarter angle',
};

const AVOID = 'floor, ground, shadow on the ground, pedestal, base, plinth, frame, border, circle, ring, '
  + 'scenery, room, wall, people, creatures, hands, text, letters';

export const ROOM_FEATURE_ART = ROOM_FEATURE_ART_THEMES.flatMap((theme) =>
  ROOM_FEATURE_ART_KINDS.map((kind) => ({
    id: `rf-${theme}-${kind}`,
    file: kind,
    dir: `assets/room-features/${theme}`,
    icon: true,
    prompt: `${KIND_SUBJECT[kind]}, styled as a ${theme} dungeon object with ${THEME_FLAVOR[theme]}, `
      + 'the single object centered and filling the picture, plain empty background',
    avoid: AVOID,
  })),
);
