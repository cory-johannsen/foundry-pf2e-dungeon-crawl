#!/usr/bin/env node
/**
 * Flood-fill a token's flat/near-uniform background to transparent.
 *
 *   node tools/make-bg-transparent.mjs <path> [threshold]
 *
 * Many `check-token-art.mjs` failures are otherwise-good art on a plain
 * white or grey studio backdrop instead of black — a real, recurring
 * pipeline failure documented at length in ITEM-18's history, usually
 * "fixed" by burning another 1-4 generation rounds. Since the background
 * in these cases is flat, it can just be keyed out directly instead.
 *
 * Samples the border pixels' own color (median, robust to a few subject
 * pixels touching the edge) rather than assuming white specifically, then
 * BFS flood-fills from every border pixel within `threshold` of that color
 * inward — so it clears a grey backdrop exactly as well as a white one,
 * and stops at the subject's own outline rather than eating into it.
 *
 * `check-token-art.mjs` reads pixels via `Image.open(path).convert('L')`,
 * which drops alpha entirely — a pixel that's merely *transparent* still
 * reads as whatever color it still holds. So cleared pixels are set to
 * (0,0,0,0): black AND transparent, so the checker sees "clean black
 * background" and Foundry's own rendering sees genuine transparency
 * (better than a solid black square token, which this module's own
 * black-background convention only ever used as a value that dark-background
 * checker measured cleanly — transparency was never available mid-diffusion,
 * only as this kind of post-process).
 *
 * `exact=True` on the save is required, not cosmetic: libwebp's lossless
 * encoder is otherwise free to discard/repaint the RGB of fully-transparent
 * pixels for better compression, so a (0,0,0,0) pixel can round-trip as
 * (247,246,242,0) on disk — invisible in Foundry, but still bright to the
 * alpha-blind checker above. Confirmed live on giant-flying-squirrel: without
 * `exact`, ~42% of the pixels this tool cleared came back non-black.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = join(root, '.venv/bin/python3');

const [, , path, thresholdArg] = process.argv;
if (!path) { console.error('usage: make-bg-transparent.mjs <path> [threshold]'); process.exit(1); }
const threshold = thresholdArg ? parseInt(thresholdArg, 10) : 40;

const script = `
import sys
from collections import deque
from PIL import Image

path, threshold = sys.argv[1], int(sys.argv[2])
im = Image.open(path).convert('RGBA')
w, h = im.size
px = im.load()

border = []
for x in range(w):
    border.append(px[x, 0]); border.append(px[x, h - 1])
for y in range(h):
    border.append(px[0, y]); border.append(px[w - 1, y])
n = len(border)
def median(vals):
    s = sorted(vals)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m-1] + s[m]) // 2
ref = tuple(median([c[i] for c in border]) for i in range(3))

def close(p):
    return (abs(p[0]-ref[0]) + abs(p[1]-ref[1]) + abs(p[2]-ref[2])) <= threshold * 3

visited = bytearray(w * h)
q = deque()
def consider(x, y):
    i = y * w + x
    if not visited[i] and close(px[x, y]):
        visited[i] = 1
        q.append((x, y))

for x in range(w):
    consider(x, 0); consider(x, h - 1)
for y in range(h):
    consider(0, y); consider(w - 1, y)

cleared = 0
while q:
    x, y = q.popleft()
    px[x, y] = (0, 0, 0, 0)
    cleared += 1
    for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
        if 0 <= nx < w and 0 <= ny < h:
            consider(nx, ny)

im.save(path, 'WEBP', lossless=True, method=6, exact=True)
print(f'{{"ref": {list(ref)}, "cleared": {cleared}, "total": {w*h}, "fraction": {cleared/(w*h):.3f}}}')
`;

const out = execFileSync(PY, ['-c', script, path, String(threshold)], { encoding: 'utf8' });
console.log(path, out.trim());
