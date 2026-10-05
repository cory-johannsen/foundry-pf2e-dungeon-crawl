#!/usr/bin/env python3
"""Cut out generated room-feature art (#750) onto a transparent background.

    .venv/bin/python3 tools/cutout-room-feature-art.py <raw-dir> [out-dir]

Needs `pip install "rembg[cpu]"` in the repo .venv (downloads the isnet model
on first run). Why not tools/make-bg-transparent.mjs: these images have a dark
vignetted background, and that tool's color flood-fill also clears the dark
metal of the objects. Tokens (treasure, puzzle, skill_challenge) are cropped
to the object and padded square. Doors stay opaque: rembg only finds the
door's bounding box, and the raw image is cropped to it (a matte of a plank
door on a dark background comes out see-through). The crop is turned to lie
along the wall and squashed to a 5:1 strip: Foundry draws a wall's door
texture at the wall's length keeping the image's aspect ratio, and the leaf
swings as a whole (see the spike result in the design spec).
"""
import sys
from pathlib import Path
from PIL import Image
from rembg import remove, new_session

raw = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("assets/room-features")
session = new_session("isnet-general-use")
for src in sorted(raw.glob("*/*.webp")):
    theme, kind = src.parent.name, src.stem
    rgb = Image.open(src).convert("RGB")
    cut = remove(rgb, session=session)
    box = cut.getbbox()
    im = cut.crop(box)
    if kind == "door":
        im = rgb.convert("RGBA").crop(box)
        im = im.rotate(90, expand=True)
        im = im.resize((768, 154), Image.LANCZOS)
    else:
        side = max(im.size) + 24
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
        im = canvas.resize((512, 512), Image.LANCZOS)
    dest = out / theme / f"{kind}.webp"
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "WEBP", lossless=True, method=6, exact=True)
    print(dest)
