#!/usr/bin/env node
/**
 * Token prompts, written out for Gemini rather than ComfyUI.
 *
 *   node tools/token-prompts.mjs                  # every token
 *   node tools/token-prompts.mjs tengu ooze-tar   # just these
 *   node tools/token-prompts.mjs --write          # also refresh docs/token-prompts.md
 *
 * The subjects come from generate-token-art.mjs, so there is one list of what
 * each token shows and this cannot drift from it.
 *
 * Two things have to change on the way across:
 *
 * Gemini has no negative prompt. ComfyUI takes a second field of things to
 * keep out, and roughly a third of the work in this module has been in that
 * field — no parchment, no glass tank, no human face on the leshy. There is
 * nowhere to put it, so it goes into the sentence as an instruction instead.
 *
 * Gemini has no width and height either. ComfyUI is told 1024 by 1024 as
 * numbers; Gemini has to be told in the prompt, or it returns whatever aspect
 * ratio the description suggests — and a token that is not square gets
 * letterboxed into its frame on the map.
 *
 * The pipeline still expects a 1024 square, because the stored asset is a 512
 * webp and downscaling from 1024 is what keeps the linework clean.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SUBJECTS, CREATURES, ICONS, SIZE, TOKEN_PX, NEGATIVE, SHAPELESS_NEGATIVE, ICON_NEGATIVE
} from './generate-token-art.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The style, said as Gemini wants to hear it.
 *
 * The ComfyUI string is a bag of tags because that is what CLIP reads. Gemini
 * reads sentences, and repeating "black background, no scenery, no backdrop"
 * three times — which measurably helps CLIP — reads to it as emphasis on
 * something it was already going to do.
 */
const STYLE_PROSE =
  'Dark fantasy illustration with intricate linework, rich jewel-tone colours and dramatic '
  + 'rim lighting, in the style of a painted trading card.';

// The token style asks for intricate linework, which is exactly wrong for
// something drawn at fifty pixels: the detail is not merely wasted, it turns
// the silhouette to mud. Icons get the opposite instruction.
const ICON_PROSE =
  'Painted dark fantasy, bold and graphic, with heavy outlines, very high contrast and '
  + 'dramatic rim lighting.';

const FRAMING = {
  bust: 'Frame it as a centred bust portrait, head and shoulders, filling most of the frame.',
  shapeless: 'Show the whole creature centred and filling the frame, alone in empty black space '
    + 'with nothing beneath or behind it.',
  // An icon is looked at, not read. Saying the display size is what stops the
  // model spending its detail budget on things nobody will ever see.
  icon: 'Draw it as a bold game icon: one strong silhouette in a few large shapes with thick '
    + 'outlines and very high contrast. It is displayed about fifty pixels across, so anything '
    + 'finer than that is wasted.'
};

/**
 * The background instruction, which is the one that actually fails.
 *
 * Every token rejected by tools/check-token-art.mjs has been rejected for this
 * and nothing else, so it is stated plainly and given a reason. A model told
 * why tends to comply better than one handed a bare prohibition.
 */
const BACKGROUND =
  'The background must be plain solid black with nothing in it at all — no scenery, no ground, '
  + 'no horizon, no border and no frame. The image is a map token and is drawn over dark '
  + 'terrain, so anything behind the subject shows up as a visible square tile.';

// Same requirement, different reason. Telling a model an icon is a map token
// is simply untrue, and the true reason is at least as persuasive.
const ICON_BACKGROUND =
  'The background must be plain solid black with nothing in it at all — no scenery, no border, '
  + 'no frame and no decorative surround. It sits in a small dark square slot on a toolbar, so '
  + 'any frame reads as a box drawn around the icon.';

const dimensions = (px) =>
  `Output a square image, exactly ${px} by ${px} pixels, 1:1 aspect ratio.`;

/** Turn a ComfyUI negative list into something to say out loud. */
const avoidance = (list) => `Do not include: ${list}.`;

/** One Gemini-ready prompt for a subject. */
export function geminiPrompt(s, px = SIZE) {
  const subject = s.prompt
    ? `${s.prompt.replace(/^A /, 'A ')}.`
    : `Portrait bust of ${s.who}, wearing full plate armour, a longsword held upright at the `
      + 'shoulder, stern and watchful, sworn to service.';
  const base = s.icon ? ICON_NEGATIVE : s.shapeless ? SHAPELESS_NEGATIVE : NEGATIVE;
  const negatives = [base, s.avoid].filter(Boolean).join(', ');
  return [
    subject,
    s.icon ? ICON_PROSE : STYLE_PROSE,
    FRAMING[s.icon ? 'icon' : s.shapeless ? 'shapeless' : 'bust'],
    s.icon ? ICON_BACKGROUND : BACKGROUND,
    dimensions(px),
    avoidance(negatives)
  ].join(' ');
}

const ALL = [
  ...SUBJECTS.map((s) => ({ ...s, file: `warrior-${s.id}` })),
  ...CREATURES,
  ...ICONS
];

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const chosen = wanted.length
    ? ALL.filter((s) => wanted.includes(s.id) || wanted.includes(s.file))
    : ALL;

  if (!chosen.length) {
    console.error(`No such token. Known: ${ALL.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  const lines = [
    '# Token prompts for Gemini',
    '',
    'Generated by `node tools/token-prompts.mjs --write` from the subject list in',
    '`tools/generate-token-art.mjs`. Edit the subjects there, not this file.',
    '',
    `Ask for **${SIZE}×${SIZE}**. The stored asset is a ${TOKEN_PX}px webp, and downscaling from`,
    `${SIZE} is what keeps the linework clean; save the result to \`assets/tokens/<file>.webp\``,
    'and run `node tools/check-token-art.mjs` to confirm the background is clean.',
    '',
    'Gemini takes no negative prompt and no width and height, so both are folded into the',
    'sentence. Everything after "Do not include" is doing real work — most of the images',
    'rejected so far failed on exactly those terms.',
    ''
  ];

  for (const s of chosen) {
    lines.push(`## ${s.id}`, '', `Save as \`${s.dir ?? 'assets/tokens'}/${s.file}.webp\``, '',
               '```text', geminiPrompt(s), '```', '');
  }

  const text = lines.join('\n');
  if (write) {
    const dest = join(root, 'docs/token-prompts.md');
    writeFileSync(dest, text);
    console.log(`wrote docs/token-prompts.md (${chosen.length} prompts)`);
  } else {
    console.log(text);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
