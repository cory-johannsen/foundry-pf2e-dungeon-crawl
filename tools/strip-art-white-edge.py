#!/usr/bin/env python3
"""Strip the baked-in near-white border from dungeon-room tile art (#823) and
maintain assets/dungeon-rooms/edge-report.json (checked by
tests/dungeon-art-edges.test.mjs).

Setup (Pillow/numpy are not project deps):
    python3 -m venv .venv && .venv/bin/pip install pillow numpy   # .venv is gitignored

Usage:
    .venv/bin/python tools/strip-art-white-edge.py assets/dungeon-rooms corridor.webp plant-1.webp:mirror
    .venv/bin/python tools/strip-art-white-edge.py assets/dungeon-rooms --report-only

Per named file and side, the fringe depth d is the number of consecutive outer
rows/cols (from the edge inward) where >=50% of pixels have R,G,B > 215
(capped at 60). Sides with d == 0 are not padded (open tile edges must keep joining); on
those only border-connected white within 8px (e.g. the bright rim on the wall
strips) is inpainted. Otherwise the outer max(d,2)+2 rows/cols are overwritten from the nearest interior
row/col ("replicate", default) or by reflecting interior rows outward
("mirror"). Image size/geometry never changes. Idempotent: a cleaned image has
d=0 on every side, so a second run changes nothing. Always run
tools/make-corridor-corner.py afterwards (the corner is composited from
corridor.webp + corridor-mid.webp) and then `--report-only` (or just this
script again) to refresh the report.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

WHITE = 215
CAP = 60
QUALITY = 92
BAND = 3
SIDES = "NESW"


def near_white(a):
    return (a[..., :3] > WHITE).all(axis=-1)


def side_slices(nw, side):
    """Fraction near-white per outer line, ordered edge -> inward."""
    if side == "N":
        return nw.mean(axis=1)
    if side == "S":
        return nw.mean(axis=1)[::-1]
    if side == "W":
        return nw.mean(axis=0)
    return nw.mean(axis=0)[::-1]  # E


def depth(a, side):
    fr = side_slices(near_white(a), side)
    d = 0
    while d < min(CAP, len(fr)) and fr[d] >= 0.5:
        d += 1
    return d


def depths(a):
    return {s: depth(a, s) for s in SIDES}


def band_pct(a):
    nw = near_white(a)
    return {
        "N": float(nw[:BAND, :].mean()),
        "S": float(nw[-BAND:, :].mean()),
        "W": float(nw[:, :BAND].mean()),
        "E": float(nw[:, -BAND:].mean()),
    }


def fill(a, side, pad, mode):
    """Overwrite the outer `pad` lines on `side` (in place on a view)."""
    t = (1, 0) + tuple(range(2, a.ndim))
    v = {"N": a, "S": a[::-1], "W": a.transpose(t), "E": a[:, ::-1].transpose(t)}[side]
    if mode == "mirror":
        for i in range(pad):
            v[i] = v[2 * pad - 1 - i]
    else:
        v[:pad] = v[pad]


def shift(x, dy, dx):
    """x shifted by (dy,dx) with edge replication."""
    h, w = x.shape[:2]
    p = np.pad(x, ((1, 1), (1, 1)) + ((0, 0),) * (x.ndim - 2), mode="edge")
    return p[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]


def dilate(m):
    r = m.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            r |= shift(m, dy, dx)
    return r


OPEN_REACH = 8  # px from an unpadded side that border-connected white may be removed


def residual_corner_white(a, pads):
    """Near-white (R,G,B>200) pixels connected to a padded border line, e.g.
    the rounded-corner white that lies deeper than the straight fringe, grown
    by 2px to take the anti-aliased rim with it. Confined to pad+12 px of the
    padded sides; on the other sides only OPEN_REACH px (this catches the 1-2px
    bright rim along the wall strips of an otherwise clean open edge, while the
    dark/mid-tone floor of an open edge is never touched)."""
    h, w = a.shape[:2]
    cand = (a[..., :3] > 200).all(axis=-1)
    region = np.zeros_like(cand)
    seed = np.zeros_like(cand)
    for s_ in SIDES:
        r = pads[s_] + 12 if s_ in pads else OPEN_REACH
        if s_ == "N":
            region[:r, :] = True; seed[0, :] = True
        elif s_ == "S":
            region[-r:, :] = True; seed[-1, :] = True
        elif s_ == "W":
            region[:, :r] = True; seed[:, 0] = True
        else:
            region[:, -r:] = True; seed[:, -1] = True
    cand &= region
    reach = seed & cand
    while True:
        nxt = dilate(reach) & cand
        if (nxt == reach).all():
            break
        reach = nxt
    return dilate(dilate(reach)) & region


def inpaint(a, mask):
    """Fill masked pixels from the average of already-known 8-neighbours,
    growing inward one ring at a time (nearest-real-colour fill)."""
    a = a.astype(np.float32).copy()
    known = ~mask
    while not known.all():
        acc = np.zeros_like(a)
        cnt = np.zeros(known.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                k = shift(known, dy, dx)
                acc += shift(a, dy, dx) * k[..., None]
                cnt += k
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        a[grow] = acc[grow] / cnt[grow][..., None]
        known = known | grow
    return np.clip(a + 0.5, 0, 255).astype(np.uint8)


def clean(path, mode):
    img = Image.open(path)
    a = np.array(img.convert("RGB"))
    before = depths(a)
    out = a.copy()
    pads = {}
    for s in SIDES:
        d = before[s]
        if d >= 1:
            pads[s] = max(d, 2) + 2
    bad = residual_corner_white(a, pads)
    if pads or bad.any():
        # Pixels whose colour can't be trusted: the fringe strips plus any
        # border-connected corner white. Fill the strips from the interior,
        # carrying the "untrusted" flag along so a mirrored/replicated bright
        # corner pixel gets re-inpainted instead of becoming a speck.
        for s, pad in pads.items():
            fill(out, s, pad, mode)
            fill(bad, s, pad, mode)
        out = inpaint(out, bad)
    if pads or bad.any():
        # interior self-check: outside every pad (+ block margin) must stay put
        m = 8
        t, b, l, r = (pads.get(k, OPEN_REACH) + 12 + m for k in "NSWE")
        Image.fromarray(out).save(path, "WEBP", quality=QUALITY, method=6)
        new = np.array(Image.open(path).convert("RGB"))
        inner_old = a[t:-b, l:-r].astype(int)
        inner_new = new[t:-b, l:-r].astype(int)
        mad = float(np.abs(inner_old - inner_new).mean())
        mx = int(np.abs(inner_old - inner_new).max())
        assert mad < 1.5, f"{path}: interior drifted (mean abs diff {mad:.2f})"
        print(f"  interior drift: mean|d|={mad:.3f} max={mx} (lossy re-encode q{QUALITY})")
    else:
        new = a
    return before, depths(new), pads


def write_report(d):
    rep = {}
    for p in sorted(d.glob("*.webp")):
        a = np.array(Image.open(p).convert("RGB"))
        rep[p.name] = {
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
            "size": [a.shape[1], a.shape[0]],
            "nearWhiteOuterBandPct": {k: round(v, 4) for k, v in band_pct(a).items()},
        }
    (d / "edge-report.json").write_text(json.dumps(rep, indent=2) + "\n")
    print(f"wrote {d / 'edge-report.json'} ({len(rep)} files)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("names", nargs="*", help="file.webp or file.webp:mirror|replicate")
    ap.add_argument("--report-only", action="store_true")
    a = ap.parse_args()
    d = Path(a.dir)
    if not a.report_only:
        if not a.names:
            sys.exit("name at least one file (or use --report-only)")
        for spec in a.names:
            name, _, mode = spec.partition(":")
            mode = mode or "replicate"
            print(name, mode)
            b, af, pads = clean(d / name, mode)
            print("  before", b, "after", af, "pads", pads or "none (untouched)")
    write_report(d)


if __name__ == "__main__":
    main()
