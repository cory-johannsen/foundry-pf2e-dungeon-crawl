#!/usr/bin/env node
/**
 * Does each token sit on a plain dark background?
 *
 *   .venv/bin/python3 is required (Pillow, numpy).
 *
 * Written because eyeballing two of six was not enough: the dwarf and human
 * looked right, so the parchment backgrounds on four others went unnoticed
 * until they were measured. A token with scenery behind it reads as a square
 * tile on a map instead of blending into the ground.
 *
 * It began by averaging the four corners, and the oozes showed what that
 * misses. Three images passed in a row while being wrong in three different
 * ways: a canyon behind the tar with black sky in the corners, then a white
 * halo behind it with the corners still black. Corners are four small squares,
 * and a background can simply avoid them.
 *
 * So two measures now, both over the whole image:
 *
 *   edge    the mean brightness of a ring around the outside, not just the
 *           corners — scenery along an edge has nowhere left to hide
 *   bright  the share of pixels that are genuinely bright, which is what a
 *           pale background is and what rim lighting on a subject is not
 *
 * Neither judges whether the picture shows the right thing. The tar was a
 * wolf on one pass and passed every measure here; only a person can catch
 * that, so look at the images too.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['assets/tokens', 'assets/icons', 'assets/creature-art'].map((d) => join(root, d));
const PY = join(root, '.venv/bin/python3');

/**
 * Thresholds calibrated against the art already accepted for this module:
 * everything kept measures 14-46 on the edge and under 6 per cent bright,
 * while the three warriors known to be wrong measure 67, 95 and 134.
 */
const EDGE_LIMIT = 50;
const BRIGHT_LIMIT = 20;

const script = `
from PIL import Image
import sys, json
import numpy as np
out = {}
for path in sys.argv[1:]:
    a = np.asarray(Image.open(path).convert('L'), dtype=float)
    h, w = a.shape
    r = max(1, int(min(w, h) * 0.10))
    ring = np.concatenate([a[:r,:].ravel(), a[-r:,:].ravel(),
                           a[:,:r].ravel(), a[:,-r:].ravel()])
    out[path] = {'edge': float(ring.mean()), 'bright': float((a > 200).mean() * 100)}
print(json.dumps(out))
`;

const files = dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => f.endsWith('.webp')).map((f) => join(dir, f)));
if (!files.length) { console.log('no tokens yet'); process.exit(0); }
const stats = JSON.parse(execFileSync(PY, ['-c', script, ...files], { encoding: 'utf8' }));

console.log(`${'file'.padEnd(32)}${'edge'.padStart(8)}${'bright'.padStart(9)}   verdict`);
let bad = 0;
for (const [path, { edge, bright } ] of Object.entries(stats)) {
  const name = path.split('/').slice(-2).join('/');
  const faults = [];
  if (edge >= EDGE_LIMIT) faults.push('BACKGROUND');
  if (bright >= BRIGHT_LIMIT) faults.push('PALE BACKDROP');
  if (faults.length) bad += 1;
  const verdict = faults.length ? faults.join(' + ')
    : edge >= EDGE_LIMIT * 0.8 ? 'borderline' : 'clean';
  console.log(`${name.padEnd(32)}${edge.toFixed(1).padStart(8)}${bright.toFixed(1).padStart(9)}   ${verdict}`);
}
console.log(bad ? `\n${bad} token(s) need regenerating` : '\nall clean');
process.exit(bad ? 1 : 0);
