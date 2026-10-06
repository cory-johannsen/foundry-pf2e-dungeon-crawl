#!/usr/bin/env python3
"""Cut out generated room-feature art (#750) onto a transparent background.

    .venv/bin/python3 tools/cutout-room-feature-art.py <raw-dir> [out-dir]

Needs `pip install "rembg[cpu]"` in the repo .venv (downloads the isnet model
on first run). Why not tools/make-bg-transparent.mjs: these images have a dark
vignetted background, and that tool's color flood-fill also clears the dark
metal of the objects. Tokens (treasure, puzzle, skill_challenge) are cropped
to the object and padded square. Doors are hand-generated top-down
plank strips (about 5:1) on a plain white background: the white is keyed out
and the strip cropped and resized to 1200 wide. Foundry draws a wall's door
texture at the wall's length keeping the image's aspect ratio, and the leaf
swings as a whole (see the spike result in the design spec).
"""
import sys
from collections import deque
from pathlib import Path
from PIL import Image

raw = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("assets/room-features")
session = None


def key_bg(im, bg):
    """Clear the background (pixels where bg(pixel) is true) connected to the image border."""
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if bg(px[x, y]) and not seen[y * w + x]:
                seen[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if bg(px[x, y]) and not seen[y * w + x]:
                seen[y * w + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and bg(px[nx, ny]):
                seen[ny * w + nx] = 1
                q.append((nx, ny))
    return im


for src in sorted(p for p in raw.glob("*/*") if p.suffix.lower() in (".webp", ".jpg", ".jpeg", ".png")):
    theme, kind = src.parent.name, src.stem  # kind may carry a -N variant suffix
    rgb = Image.open(src).convert("RGB")
    if kind.startswith("door"):
        # Top-down strip. A white background (hand-made) or a flat black one
        # (OpenRouter, with a soft glow) is cropped to the door, opaque.
        corners = [rgb.getpixel(c) for c in ((2, 2), (rgb.width - 3, 2), (2, rgb.height - 3), (rgb.width - 3, rgb.height - 3))]
        dark = sum(sum(c) / 3 for c in corners) / 4 < 60
        if dark:
            # Keep the door opaque: a flood fill leaks through the door's dark
            # ink outline into the planks. Crop to the rows/columns whose mean
            # brightness shows the door (the black background and its faint
            # glow stay below the cut).
            gray = rgb.convert("L")
            cols = gray.resize((gray.width, 1), Image.BOX)
            rows = gray.resize((1, gray.height), Image.BOX)
            cut = 38
            xs = [x for x in range(gray.width) if cols.getpixel((x, 0)) > cut]
            ys = [y for y in range(gray.height) if rows.getpixel((0, y)) > cut]
            im = rgb.convert("RGBA").crop((xs[0], ys[0], xs[-1] + 1, ys[-1] + 1))
        else:
            im = key_bg(rgb, lambda p: p[0] > 228 and p[1] > 228 and p[2] > 228)
            im = im.crop(im.getbbox())
        im = im.resize((1200, round(1200 * im.height / im.width)), Image.LANCZOS)
    else:
        if session is None:
            from rembg import remove, new_session
            session = new_session("isnet-general-use")
        cut = remove(rgb, session=session)
        im = cut.crop(cut.getbbox())
        side = max(im.size) + 24
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
        im = canvas.resize((512, 512), Image.LANCZOS)
    dest = out / theme / f"{kind}.webp"
    dest.parent.mkdir(parents=True, exist_ok=True)
    im.save(dest, "WEBP", lossless=True, method=6, exact=True)
    print(dest)
