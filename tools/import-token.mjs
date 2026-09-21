#!/usr/bin/env node
/**
 * Take a token image drawn somewhere else and put it where the module wants it.
 *
 *   node tools/import-token.mjs ~/Downloads/whatever.jpg ooze-cube
 *   npm run tokens:import -- ~/Downloads/whatever.jpg ooze-cube
 *
 * The ComfyUI generator is not the only source of this art — some of it is
 * drawn in Gemini from the prompts in docs/token-prompts.md and handed over as
 * a file. The steps after that are the same either way and are easy to get
 * subtly wrong: the destination is a webp at 512 with a name the handler code
 * already refers to, not whatever the file arrived as.
 *
 * The name is checked against the subject list rather than taken on trust,
 * because a token saved under a name no card looks for is invisible — the
 * summons simply arrives with the system's default silhouette and nothing
 * anywhere says why.
 *
 * The same background measure runs afterwards, so a picture that will not sit
 * on a dark map is rejected here rather than discovered on the map.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';
import { SUBJECTS, CREATURES, TOKEN_PX } from './generate-token-art.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = join(root, '.venv/bin/python3');
const OUT_DIR = join(root, 'assets/tokens');

const ALL = [
  ...SUBJECTS.map((s) => ({ ...s, file: `warrior-${s.id}` })),
  ...CREATURES
];

/** The file a token id writes to, or null if nothing claims that name. */
export function fileFor(name) {
  const hit = ALL.find((s) => s.id === name || s.file === name);
  return hit ? hit.file : null;
}

const [src, name] = process.argv.slice(2);

if (!src || !name) {
  console.error('usage: node tools/import-token.mjs <image> <token>\n'
    + `tokens: ${ALL.map((s) => s.id).join(', ')}`);
  process.exit(1);
}
if (!existsSync(src)) {
  console.error(`no such file: ${src}`);
  process.exit(1);
}

const file = fileFor(name);
if (!file) {
  console.error(`nothing is named "${name}", so no card would ever load it.\n`
    + `tokens: ${ALL.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const dest = join(OUT_DIR, `${file}.webp`);

/**
 * Trim the mount, then pad to square. Never crop the subject.
 *
 * An image can arrive matted: the drake came back as a black panel centred in
 * a white page, which is a picture of a picture. Removing the white by making
 * it transparent would leave the panel's own hard edge behind, so the token
 * would be a black rectangle on the map — the exact fault the background check
 * exists to catch, arrived at from the other direction. The mount has to go
 * rather than be hidden, so a uniform border of any colour is trimmed away.
 *
 * What is left is usually not square, and it is padded rather than cropped.
 * Cropping to the short side is what this did first, and on this drake it
 * would have taken thirty-five pixels off the top, where its horns are. The
 * background is flat by construction, so padding with the border's own colour
 * is invisible and cannot lose any of the creature.
 */
const convert = `
from PIL import Image, ImageChops
import sys
import numpy as np

src, dest, px = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src).convert('RGB')
before = im.size

def border_colour(img, inset=0):
    # Sampled a few pixels in, not on the cut itself. Straight after a trim the
    # outermost row IS the boundary between mount and artwork, so measuring it
    # returns the average of the two — which padded this drake in grey and was
    # rejected by the background check for being exactly that.
    a = np.asarray(img)
    if inset and min(a.shape[:2]) > inset * 4:
        a = a[inset:-inset, inset:-inset]
    edge = np.concatenate([a[0,:], a[-1,:], a[:,0], a[:,-1]])
    return tuple(int(v) for v in np.median(edge, axis=0))

# Trim any uniform mount. A tolerance of 12 ignores jpeg noise in a flat field
# without eating into the artwork, whose edge is a hard line against it.
mount = border_colour(im)
bbox = ImageChops.difference(im, Image.new('RGB', im.size, mount)).convert('L').point(
    lambda v: 255 if v > 12 else 0).getbbox()
if bbox and (bbox[2] - bbox[0]) > im.width * 0.2 and (bbox[3] - bbox[1]) > im.height * 0.2:
    if bbox != (0, 0, im.width, im.height):
        im = im.crop(bbox)
        print(f'trimmed {before[0]}x{before[1]} mount rgb{mount} to {im.width}x{im.height}')

w, h = im.size
if w != h:
    s = max(w, h)
    pad = border_colour(im, inset=3)
    square = Image.new('RGB', (s, s), pad)
    square.paste(im, ((s - w) // 2, (s - h) // 2))
    im = square
    print(f'padded {w}x{h} to square {s}x{s} with rgb{pad}')

im.resize((px, px), Image.LANCZOS).save(dest, 'WEBP', quality=90, method=6)
`;

execFileSync(PY, ['-c', convert, src, dest, String(TOKEN_PX)], { stdio: 'inherit' });
console.log(`${basename(src)} -> assets/tokens/${file}.webp (${TOKEN_PX}px)`);

// Report the same measure the checker uses, so a bad background is caught now.
try {
  execFileSync('node', [join(root, 'tools/check-token-art.mjs')], { stdio: 'pipe', encoding: 'utf8' });
} catch (err) {
  const line = String(err.stdout ?? '').split('\n').find((l) => l.startsWith(`${file}.webp`));
  if (line) {
    console.error(`\n${line.trim()}\n`
      + 'That background will read as a square tile on a dark map. '
      + 'The original is untouched, so it can be redrawn and imported again.');
    process.exit(1);
  }
}
console.log('background clean');

// Only once it is known good: the source file has served its purpose and
// leaving it in the working tree is how it ends up committed by accident.
// resolve() first: the path is usually typed relative to the repo, and a bare
// startsWith on that never matches, so the file quietly stayed behind.
if (process.argv.includes('--keep')) process.exit(0);
if (resolve(src).startsWith(root)) {
  unlinkSync(src);
  console.log(`removed ${basename(src)}`);
} else {
  console.log(`left ${basename(src)} where it was`);
}
