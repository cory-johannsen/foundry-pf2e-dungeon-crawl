#!/usr/bin/env python3
"""Compose the five shipped corridor floor pieces (#857) from shared source
assets in tools/corridor-art-sources/ instead of #823's "paste a patch over a
closed box" approach. Every piece's open edge is the SAME floor pixels by
construction, so two pieces joined side by side show no seam.

Canonical openings (verbatim from scripts/corridor-pieces.mjs's own doc
comment -- tests/corridor-pieces.test.mjs cross-checks this stays in sync):
  end@0 open S; mid@0 open N+S; corner@0 walls N+W, open S+E.
(Foundry rotates tiles clockwise; single = walls on all four sides.)

Sources (see tools/corridor-art-sources/):
  floor.png       ComfyUI-generated flagstone floor (1024px). The central crop
                  is made periodic (wrap-blended) so a tile's left edge
                  continues its right edge and top continues bottom: that is
                  what makes adjacent pieces' open edges seamless.
  wall-strip.png  the wall rim + sloped face band cropped from the previous
                  corridor.webp (generation could not deliver a matching strip).
                  It is mirror-tiled to the tile width with a period equal to
                  the tile size, so it also wraps seamlessly along the wall.
  rubble-fill.png the rubble pile from the previous corridor-rubble.webp.

Walls: one N-wall layer is rotated for the other sides. Where two walls meet
the strips are mitred on the 45 degree diagonal (feathered); the wall's inner
edge fades softly into the floor so it does not read as a pasted rectangle.

Usage:
    .venv/bin/python tools/compose-corridor-pieces.py [--out assets/dungeon-rooms]
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image

SRC = Path(__file__).resolve().parent / "corridor-art-sources"

# walls per piece at rotation 0
PIECES = {
    "corridor.webp": "NESW",   # single
    "corridor-end.webp": "NEW",  # open S
    "corridor-mid.webp": "EW",   # open N+S
    "corridor-corner.webp": "NW",  # open S+E
    "corridor-rubble.webp": "NEW",  # end shape + rubble
}


def load(p):
    return np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)


def make_periodic(big, n, b):
    """n x n tile from big (>= n+b square) whose edges wrap seamlessly."""
    s = big[: n + b, : n + b]
    w = (np.arange(b, dtype=np.float32) / b)
    w = (w * w * (3 - 2 * w))  # smoothstep 0->1
    # x axis
    tx = s[:, :n].copy()
    tx[:, :b] = w[None, :, None] * s[:, :b] + (1 - w[None, :, None]) * s[:, n:n + b]
    # y axis
    t = tx[:n].copy()
    t[:b] = w[:, None, None] * tx[:b] + (1 - w[:, None, None]) * tx[n:n + b]
    return t


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def floor_tile(n, b=128, flat=8, blend=40):
    """Periodic floor crop whose outer rim is a flat, perfectly symmetric
    joint: a thin dark grout line on the tile border (two abutting tiles make
    one slab joint) over the floor's mean colour. The rim is identical on all
    four sides and constant along each side, so ANY rotation of ANY piece
    meets any neighbour's open edge continuously (rotation-safe by design),
    and the real slab detail fades in over `blend` px."""
    big = load(SRC / "floor.png")
    h, w = big.shape[:2]
    y0, x0 = (h - (n + b)) // 2, (w - (n + b)) // 2
    p = make_periodic(big[y0:y0 + n + b, x0:x0 + n + b], n, b)
    mean = p.reshape(-1, 3).mean(axis=0)
    lum = p.mean(axis=2)
    grout = p[lum <= np.percentile(lum, 6)].mean(axis=0)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    d = np.minimum(np.minimum(xx, n - 1 - xx), np.minimum(yy, n - 1 - yy))
    m = (1 - smooth((d - flat) / blend))[..., None]
    g = (1 - smooth((d - 1.0) / 3.0))[..., None]
    q = mean[None, None, :] * (1 - g) + grout[None, None, :] * g
    return p * (1 - m) + q * m


def north_layer(n, depth):
    """n x n RGB with the wall band along the top (rim at row 0)."""
    strip = load(SRC / "wall-strip.png")
    sh, sw = strip.shape[:2]
    # mirror-tile to a period of exactly n
    reps = [strip, strip[:, ::-1]]
    row = np.concatenate(reps * (n // (2 * sw) + 1), axis=1)[:, :n]
    band = np.asarray(Image.fromarray(row.astype(np.uint8)).resize((n, depth), Image.LANCZOS), dtype=np.float32)
    out = np.zeros((n, n, 3), np.float32)
    out[:depth] = band
    return out


def side_alpha(n, depth, walls, fade, miter_feather=10.0):
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    d = {"N": yy, "S": n - 1 - yy, "W": xx, "E": n - 1 - xx}
    perp = {"N": "EW", "S": "EW", "E": "NS", "W": "NS"}
    alphas = {}
    for s in walls:
        a = smooth((depth - d[s]) / fade)  # soft inner edge
        for t in perp[s]:
            if t in walls:
                # diagonal mitre: this strip owns pixels nearer its own edge
                a = a * smooth((d[t] - d[s]) / miter_feather + 0.5)
        alphas[s] = a
    return alphas


ROT = {"N": 0, "W": 1, "S": 2, "E": 3}  # np.rot90 k (counter-clockwise)


def build_piece(floor, north, walls, n, depth, fade=26):
    out = floor.copy()
    # soft shadow cast by each wall onto the floor
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    d = {"N": yy, "S": n - 1 - yy, "W": xx, "E": n - 1 - xx}
    shade = np.ones((n, n), np.float32)
    for s in walls:
        shade *= 1 - 0.18 * np.exp(-np.maximum(d[s] - depth, 0) / 24.0)
    out *= shade[..., None]
    alphas = side_alpha(n, depth, walls, fade)
    for s in "NEWS":
        if s not in walls:
            continue
        layer = np.rot90(north, ROT[s])
        a = alphas[s][..., None]
        out = out * (1 - a) + layer * a
    return out


def add_rubble(img, n):
    rub = Image.open(SRC / "rubble-fill.png").convert("RGB")
    pw, ph = int(n * 0.80), int(n * 0.56)
    rub = np.asarray(rub.resize((pw, ph), Image.LANCZOS), dtype=np.float32)
    cx, cy = n // 2, int(n * 0.60)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    # rounded blob mask: superellipse, feathered
    r = (np.abs((xx - cx) / (pw / 2)) ** 3 + np.abs((yy - cy) / (ph / 2)) ** 3) ** (1 / 3)
    a = smooth((1.0 - r) / 0.25)
    full = np.zeros((n, n, 3), np.float32)
    x0, y0 = cx - pw // 2, cy - ph // 2
    full[y0:y0 + ph, x0:x0 + pw] = rub
    return img * (1 - a[..., None]) + full * a[..., None]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="assets/dungeon-rooms")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--wall-depth", type=int, default=92)
    a = ap.parse_args()
    n = a.size
    floor = floor_tile(n)
    north = north_layer(n, a.wall_depth)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, walls in PIECES.items():
        base = add_rubble(floor, n) if name == "corridor-rubble.webp" else floor
        img = build_piece(base, north, walls, n, a.wall_depth)
        Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(out / name, "WEBP", quality=92)
        print(f"-> {out / name}")


if __name__ == "__main__":
    main()
