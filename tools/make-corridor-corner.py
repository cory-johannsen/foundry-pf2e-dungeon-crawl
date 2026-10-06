#!/usr/bin/env python3
"""Compose assets/dungeon-rooms/corridor-corner.webp (#823) from the existing
corridor pieces: walls on N+W, open on S+E (canonical; the module rotates it
clockwise). Pure composition of existing art, no generation.

Regions (n = tile size):
  TL  from corridor.webp          (N+W walls and their meeting corner)
  TR  from corridor-mid rotated   (N wall, E edge identical to a rotated mid)
  BL  from corridor-mid           (W wall, S edge identical to a mid)
  BR  split on the diagonal: below it the bottom-right of mid (so the S edge
      matches a mid below), above it the bottom-right of the rotated mid (so
      the E edge matches a rotated mid to the east). Seams are feathered.
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def load(src, name):
    return np.asarray(Image.open(Path(src) / name).convert("RGB"), dtype=np.float32)


def ramp(t, width):
    """Smooth 0..1 step across `width` px centred on t=0."""
    return np.clip(t / width + 0.5, 0.0, 1.0)


def build(single, mid, feather=110, dfeather=40):
    n = single.shape[0]
    h = n // 2
    mid_h = np.rot90(mid, k=-1)  # clockwise 90: walls N+S, open E+W
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    # Weights of the "right" (x) and "bottom" (y) halves, feathered at the seams.
    wx = ramp(xx - h, feather)[..., None]
    wy = ramp(yy - h, feather)[..., None]
    # Diagonal split inside the bottom-right quadrant: 1 -> use mid (S edge).
    wd = ramp((yy - h) - (xx - h), dfeather)[..., None]
    br = wd * mid + (1 - wd) * mid_h
    top = (1 - wx) * single + wx * mid_h       # TL single, TR rotated mid
    bottom = (1 - wx) * mid + wx * br          # BL mid, BR split
    out = (1 - wy) * top + wy * bottom
    return np.clip(out, 0, 255).astype(np.uint8), mid, mid_h


def to_img(a):
    return Image.fromarray(a)


def proof(corner_img, mid_img, path, rot):
    """Corner at `rot` (clockwise) with a mid joined to each open side."""
    n = corner_img.size[0]
    sheet = Image.new("RGB", (n * 2, n * 2), (0, 0, 0))
    sheet.paste(corner_img, (0, 0))
    sheet.paste(mid_img, (0, n))                                        # S side
    sheet.paste(mid_img.transpose(Image.Transpose.ROTATE_270), (n, 0))  # E side
    sheet.paste(corner_img.transpose(Image.Transpose.ROTATE_180), (n, n))  # filler
    for _ in range((rot // 90) % 4):
        sheet = sheet.transpose(Image.Transpose.ROTATE_270)
    sheet.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="assets/dungeon-rooms")
    ap.add_argument("--out", default="assets/dungeon-rooms/corridor-corner.webp")
    ap.add_argument("--preview", default=None, help="contact sheet png path")
    ap.add_argument("--proof", default=None, help="large join proof png path")
    a = ap.parse_args()
    single, mid = load(a.src, "corridor.webp"), load(a.src, "corridor-mid.webp")
    arr, _, _ = build(single, mid)
    corner = to_img(arr)
    corner.save(a.out, "WEBP", quality=90)
    corner = Image.open(a.out).convert("RGB")  # judge what is actually shipped
    mid_img = to_img(mid.astype(np.uint8))
    n = corner.size[0]
    if a.preview:
        sheet = Image.new("RGB", (n * 4, n * 3), (0, 0, 0))
        for i, rot in enumerate((0, 90, 180, 270)):
            c = corner.rotate(-rot)  # PIL rotate is CCW; negative = CW
            sheet.paste(c, (i * n, 0))
            # a mid joined to each open side, rotated with the corner
            cell = Image.new("RGB", (n * 2, n * 2))
            cell.paste(corner, (0, 0))
            cell.paste(mid_img, (0, n))
            cell.paste(mid_img.transpose(Image.Transpose.ROTATE_270), (n, 0))
            cell = cell.rotate(-rot)
            sheet.paste(cell.resize((n, n)), (i * n, n))
            sheet.paste(mid_img.rotate(-rot), (i * n, 2 * n))
        sheet.save(a.preview)
    if a.proof:
        pw = Image.new("RGB", (n * 4, n * 2), (0, 0, 0))
        for i, rot in enumerate((0, 90)):
            p = Path(a.proof).with_suffix(f".r{rot}.png")
            proof(corner, mid_img, p, rot)
            pw.paste(Image.open(p), (i * n * 2, 0))
            p.unlink()
        pw.save(a.proof)


if __name__ == "__main__":
    main()
