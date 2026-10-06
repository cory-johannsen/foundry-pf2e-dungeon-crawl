/**
 * Generator subjects for the themed room-feature art (#750): one image per
 * room theme and kind, written to assets/room-features/<theme>/<kind>.webp.
 * Imported into generate-token-art.mjs's ALL list, so the generator's
 * ComfyUI-first / OpenRouter-fallback backends and skip-if-exists behavior
 * apply unchanged. Ids are `rf-<theme>-<kind>`, e.g.
 *   node tools/generate-token-art.mjs rf-undead-treasure
 * Then cut each result out with tools/cutout-room-feature-art.py (rembg).
 * Door art is the exception: ComfyUI cannot draw a strict top-down view, so the
 * shipped doors were hand-generated in Gemini from DOOR_SUBJECT plus the theme
 * flavor, on a plain white background, and cut out by the same script.
 * No apostrophes in any string here; the generator builds JS strings from them.
 */
import { ROOM_FEATURE_ART_THEMES, ROOM_FEATURE_ART_BASE_KINDS, ROOM_FEATURE_ART_STATE_KINDS } from '../scripts/room-feature-art.mjs';

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
export const DOOR_SUBJECT = 'a single heavy wooden dungeon door lying flat, seen from directly above in strict orthographic plan view like a battle map door symbol, a long narrow horizontal rectangle of vertical planks with two iron hinge straps at the left end and a ring handle and lock plate near the right end, flat 2D painted illustration, no perspective, no side view, no wall, no archway, no door frame, no shadow, the door filling the frame edge to edge as one wide strip, aspect ratio 5:1';
const KIND_SUBJECT = {
  door: DOOR_SUBJECT,
  treasure: 'a closed treasure chest with a lid and a lock, seen from a three-quarter angle',
  puzzle: 'a small free-standing puzzle device, a compact cluster of rotating dials and sliding blocks around a keyhole, seen from a three-quarter angle',
  skill_challenge: 'a tall trial standard, a pole topped with a banner and crossed tools, seen from a three-quarter angle',
  door_locked: 'a single heavy wooden dungeon door lying flat, seen from directly above in strict orthographic plan view like a battle map door symbol, a long narrow horizontal rectangle of vertical planks with two iron hinge straps at the left end and a ring handle and lock plate near the right end, with a heavy iron chain and a large padlock looped tightly across the ring handle and lock plate, visibly locked and barred shut, flat 2D painted illustration, no perspective, no side view, no wall, no archway, no door frame, no shadow, the door filling the frame edge to edge as one wide strip, aspect ratio 5:1',
  treasure_used: 'an open, emptied treasure chest with its lid thrown fully back, the bare interior visible and empty, seen from a three-quarter angle',
  puzzle_used: 'a small free-standing puzzle device with every dial and sliding block aligned and settled motionless into place, a solved and quiescent mechanism, seen from a three-quarter angle',
  skill_challenge_used: 'a tall trial standard with its banner lowered and furled tight against the pole, the crossed tools now resting still and spent, a completed challenge marker, seen from a three-quarter angle',
};

/** System prompt for token subjects: the shared creature prompt forces a
 * head-and-shoulders bust, which ruins objects (same fix as the trap art). */
export const ROOM_FEATURE_OBJECT_SYSTEM_PROMPT = [
  'You are generating a single dark-fantasy object illustration for a tabletop VTT token. Follow these rules exactly:',
  '1. SUBJECT: The described object ONLY, centered and filling most of the frame. It is an inanimate thing: no creature, no face, no eyes, no person, no character, no bust portrait.',
  '2. BACKGROUND: Plain, flat, solid BLACK background. Nothing else in the frame: no landscape, no room, no ground, no floor, no shadow on a floor, no walls, no props.',
  '3. STYLE: Hand-painted dark fantasy illustration with intricate linework and rich saturated colors. Not a photograph, not a 3D render.',
  '4. NO TEXT: No watermark, signature, logo or lettering.',
  '5. NO FRAMES: No circular border, halo, ring, medallion or decorative frame around the subject.',
].join('\n\n');

/** System prompt for door and door_locked: a top-down plan-view door leaf. */
export const ROOM_FEATURE_DOOR_SYSTEM_PROMPT = [
  'You are generating a single top-down door symbol for a tabletop VTT battle map. Follow these rules exactly:',
  '1. SUBJECT: One door leaf lying flat, seen in strict top-down orthographic plan view like a battle-map door symbol. It is a long narrow horizontal strip filling the frame edge to edge.',
  '2. BACKGROUND: Plain, flat, solid pure WHITE background. Nothing else in the frame.',
  '3. STYLE: Hand-painted 2D dark fantasy illustration with intricate linework and rich colors. Not a photograph, not a 3D render.',
  '4. NO PERSPECTIVE: No side view, no front view, no three-quarter view, no depth.',
  '5. NO SURROUNDINGS: No wall, no archway, no door frame, no floor, no shadow.',
  '6. NO TEXT: No watermark, signature, logo or lettering.',
].join('\n\n');

const systemPromptFor = (kind) => (kind === 'door' || kind === 'door_locked'
  ? ROOM_FEATURE_DOOR_SYSTEM_PROMPT
  : ROOM_FEATURE_OBJECT_SYSTEM_PROMPT);

const AVOID = 'floor, ground, shadow on the ground, pedestal, base, plinth, frame, border, circle, ring, '
  + 'scenery, room, wall, people, creatures, faces, heads, monsters, hands, text, letters, square plate, panel';

// #764: floor-variant proof batch -- the "undead" theme's own 2 extra
// floor variants (1, 2) for all 4 base kinds, proving the variant pipeline
// end to end. Every other theme's variants 1/2 are a tracked follow-up
// batch through this exact same mechanism, not generated here.
// #764: floor variants 1 and 2 for every theme. Variant 0 is the unsuffixed base
// image. The wording nudges each variant to a visibly different design.
const FLOOR_VARIANTS = [1, 2];
const VARIANT_WORDING = {
  1: 'a differently shaped, more weathered and worn variation',
  2: 'a differently shaped, more ornate and elaborate variation',
};

function kindSubject(theme, kind) {
  return `${KIND_SUBJECT[kind]}, styled as a ${theme} dungeon object with ${THEME_FLAVOR[theme]}, `
    + 'an inanimate object only, no creature and no face, the single object centered and filling the picture, plain empty background';
}

export const ROOM_FEATURE_ART = [
  ...ROOM_FEATURE_ART_THEMES.flatMap((theme) =>
    ROOM_FEATURE_ART_BASE_KINDS.map((kind) => ({
      id: `rf-${theme}-${kind}`,
      file: kind,
      dir: `assets/room-features/${theme}`,
      icon: true,
      prompt: kindSubject(theme, kind),
      systemPrompt: systemPromptFor(kind),
      avoid: AVOID,
    })),
  ),
  // #764 state variants: one per theme per state kind, no floor-variant axis.
  ...ROOM_FEATURE_ART_THEMES.flatMap((theme) =>
    ROOM_FEATURE_ART_STATE_KINDS.map((kind) => ({
      id: `rf-${theme}-${kind}`,
      file: kind,
      dir: `assets/room-features/${theme}`,
      icon: true,
      prompt: kindSubject(theme, kind),
      systemPrompt: systemPromptFor(kind),
      avoid: AVOID,
    })),
  ),
  // #764 floor variants 1 and 2 for every theme (undead's were the first batch).
  ...ROOM_FEATURE_ART_THEMES.flatMap((theme) =>
    FLOOR_VARIANTS.flatMap((variant) =>
      ROOM_FEATURE_ART_BASE_KINDS.map((kind) => ({
        id: `rf-${theme}-${kind}-${variant}`,
        file: `${kind}-${variant}`,
        dir: `assets/room-features/${theme}`,
        icon: true,
        prompt: `${kindSubject(theme, kind)}, ${VARIANT_WORDING[variant]}`,
        systemPrompt: systemPromptFor(kind),
        avoid: AVOID,
      })),
    ),
  ),
];
