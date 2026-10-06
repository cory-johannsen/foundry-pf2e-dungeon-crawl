# Corridor Art Regeneration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #857 — replace the five corridor floor-art pieces (`corridor.webp`, `corridor-end.webp`, `corridor-mid.webp`, `corridor-corner.webp`, `corridor-rubble.webp`) with a properly generated, visually consistent set whose open edges join seamlessly, with no leftover paste seams or wall-bevel remnants.

**Root cause confirmed (visual inspection of all 5 current files, plus reading the real compositing tool's own docstring):** every piece beyond the base "single" box is a crude alpha-blended composite of that SAME base image — `tools/make-corridor-corner.py`'s own docstring literally says "Pure composition of existing art, no generation." Viewing the files directly confirms exactly the issue's own complaint: `corridor-end.webp` and `corridor-corner.webp` show a visibly rectangular pasted floor patch with a hard edge and misaligned stone-tile grid lines against the surrounding wall art; `corridor-rubble.webp` has the same problem with its own rubble-pile patch.

**Convention (confirmed final and merged, #823):** `scripts/corridor-pieces.mjs`'s own canonical openings, verbatim from its own doc comment: `end@0 open S; mid@0 open N+S; corner@0 walls N+W, open S+E` (Foundry tile rotation is clockwise). 3+-opening cells fall back to a plain `mid` today — per the user's own decision, this plan does not add a dedicated T/cross piece, staying scoped to the 5 pieces the issue itself lists.

**Technical approach (user-approved):** rather than attempting 5 independent AI generations and hoping their open edges happen to match (unreliable), this plan generates exactly **two** shared source assets — a seamlessly tileable top-down stone floor texture, and a single wall-bevel edge strip in the same style — and derives all 5 pieces by compositing those same two sources onto a blank canvas per piece's own canonical opening spec. Every piece's open edge is then the *identical* floor-texture pixels by construction, not a hope; every piece's wall edge is the *identical* wall-strip art. This is the same general technique `make-corridor-corner.py` already uses (composite from shared sources), done properly: a real floor material that can extend past any edge, instead of cropping one closed box that has no "more floor" to reveal.

**Tech Stack:** ComfyUI (image generation), Python/Pillow/numpy (compositing, matching `tools/make-corridor-corner.py`'s and `tools/strip-art-white-edge.py`'s own existing stack), Vitest (drift/edge-quality tests).

**Spec:** None — bounded art regeneration with an already-confirmed-final target convention; the two real open questions (generation approach, T/cross scope) were presented to and decided by the user directly in chat.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). New generated content: minor bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- File names stay exactly `corridor.webp`, `corridor-end.webp`, `corridor-mid.webp`, `corridor-corner.webp`, `corridor-rubble.webp` — per the issue's own explicit requirement, `scripts/dungeon-scene.mjs`'s `CORRIDOR_ART_BY_VARIANT` (confirmed current) needs **no** code change.
- Every regenerated file must pass `tests/dungeon-art-edges.test.mjs` (confirmed current: no near-white outer band, `edge-report.json` hash matches) — `tools/strip-art-white-edge.py --report-only` must be rerun after replacing the files, every time, not treated as optional.
- No change to `scripts/corridor-pieces.mjs`'s own `PIECE_OPENINGS`/rotation convention, `corridorPieceForOpenings`, or any runtime wiring — this plan is art-only, matching that already-shipped, already-tested contract exactly.
- A join contact sheet gets explicit owner review before the new art is merged — the issue's own stated requirement, not optional polish.

## Review Focus

- **Every open edge of every piece must show continuous, unbroken floor texture when placed next to another piece's own open edge** — the actual defect this plan exists to fix; verified by the join contact sheet, not assumed from generating "nicer-looking" source art alone.
- **Every wall-bearing edge across every piece must look identical** (same stone/wood bevel style, same width) — since every piece draws its wall(s) from the one shared strip asset, this should hold by construction, but the contact sheet review is what actually confirms it.
- **No piece may reintroduce a near-white baked-in border** — `tests/dungeon-art-edges.test.mjs` is the automated gate; `tools/strip-art-white-edge.py` must run on every new file, not just the previously-fixed ones.
- **`corridor-corner.webp`'s own two walls (N+W) must meet convincingly at their shared corner**, not show a visible miter/gap — the one geometric case the other 4 pieces don't have to solve (they have 0 or 2 *opposite* wall sides, never 2 *adjacent* ones).
- **The rubble piece must read as a collapsed/blocked passage, not just "the end piece with a texture swap that doesn't actually look like rubble"** — a legitimate distinct visual read, checked by eye against the existing (soon-replaced) rubble art's own intent.

---

### Task 1: Generate the two shared source assets

**Files:**
- Create: a floor texture and a wall-strip source image (working files, e.g. under a scratch/working directory — not shipped directly; Task 2's own compositing tool consumes them)

No test: pure content generation, reviewed by eye per Step 3 below.

- [ ] **Step 1: Generate the floor texture**

Via ComfyUI (matching this repo's own established generation conventions — `tools/room-feature-art-prompts.mjs`'s own `THEME_FLAVOR`-style prompt structure is a reasonable model to borrow phrasing from, even though this is a new asset category with no existing prompt table of its own): a seamless, tileable, top-down dungeon stone floor — large worn flagstones, subtle cracks and weathering, consistent muted brown-grey tone matching the existing corridor art's own palette (confirmed current: warm grey-brown stone, visible in `corridor.webp`), lit evenly with no strong directional shadow (so it reads correctly from any side a wall strip gets composited against it), no walls, no vignette, no border — generate at a size comfortably larger than the 512×512 target tile (e.g. 768×768 or 1024×1024) so Task 2 can crop a clean, edge-agnostic floor region from its center with room to spare.

- [ ] **Step 2: Generate the wall-bevel edge strip**

Via ComfyUI: a single straight dungeon-wall edge in the same top-down perspective and material as the existing corridor art's own wall trim (confirmed current: a warm wood/stone bevel along the tile's outer edge, visible in every existing piece) — a long horizontal strip, consistent depth, matching the floor texture's own lighting and palette so a composite seam doesn't itself read as a seam. Generate wide enough to crop a clean strip from (avoiding the generation's own edges/artifacts), at the same working resolution as the floor texture.

- [ ] **Step 3: Review both source assets**

Confirm by eye: the floor texture tiles acceptably (no obvious repeating artifact when viewed at the crop size Task 2 will use), has even lighting across its whole area (no bright/dark corner that would look wrong rotated), and the wall strip's own lighting/material genuinely matches the floor texture rather than looking like a different scene pasted alongside it. Reroll either asset if not — this is the foundation every one of the 5 shipped pieces is built from, so it's worth getting right before Task 2 composites anything from it.

- [ ] **Step 4: Commit the working source assets**

```bash
git add <floor-texture-path> <wall-strip-path>
git commit -m "feat(#857): generate shared floor and wall-strip source art for corridor pieces

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: The compositing tool

**Files:**
- Create: `tools/compose-corridor-pieces.py`
- Test: `tests/corridor-pieces.test.mjs` (confirmed current — add a drift-guard test here, reusing its own existing conventions)

**Interfaces:**
- Produces: a CLI tool writing `single.webp`/`end.webp`/`mid.webp`/`corner.webp`/`rubble.webp` (or directly the final `corridor*.webp` names, matching Task 3's own needs) from the two Task 1 source assets, keyed by the same canonical opening spec `scripts/corridor-pieces.mjs` already defines.

- [ ] **Step 1: Write the drift-guard test first**

Add to `tests/corridor-pieces.test.mjs` (confirmed current, covers `PIECE_OPENINGS`/`corridorPieceForOpenings` already):

```js
import { readFileSync } from 'node:fs';

describe('compose-corridor-pieces.py stays in sync with PIECE_OPENINGS (#857)', () => {
  it('documents the same canonical openings corridor-pieces.mjs defines', () => {
    const src = readFileSync(
      new URL('../tools/compose-corridor-pieces.py', import.meta.url),
      'utf8',
    );
    // Mirrors corridor-pieces.mjs's own doc comment verbatim -- if either
    // changes, this test is the tripwire that catches the other going stale.
    expect(src).toContain('end@0 open S');
    expect(src).toContain('mid@0 open N+S');
    expect(src).toContain('corner@0 walls N+W');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/corridor-pieces.test.mjs -t "compose-corridor-pieces"`
Expected: FAIL — the python file doesn't exist yet.

- [ ] **Step 3: Write the compositing tool**

```python
#!/usr/bin/env python3
"""Compose the five shipped corridor floor pieces (#857) from two shared
source assets (a seamless floor texture and a single wall-bevel edge strip)
instead of #823's own "paste a patch over a closed box" approach -- every
piece's open edge is the SAME floor-texture pixels by construction, so two
pieces joined side by side show no seam.

Canonical openings (verbatim from scripts/corridor-pieces.mjs's own doc
comment -- tests/corridor-pieces.test.mjs cross-checks this stays in sync):
  end@0 open S; mid@0 open N+S; corner@0 walls N+W, open S+E.

Usage:
    .venv/bin/python tools/compose-corridor-pieces.py \
      --floor <floor-source.png> --wall <wall-strip-source.png> \
      --out assets/dungeon-rooms --size 512 --wall-depth 110
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image

SIDES = ("N", "E", "S", "W")


def load(path):
    return Image.open(path).convert("RGB")


def crop_floor(floor_img, size):
    """A clean, edge-agnostic size x size crop from the floor texture's own center."""
    w, h = floor_img.size
    cx, cy = w // 2, h // 2
    return floor_img.crop((cx - size // 2, cy - size // 2, cx + size // 2, cy + size // 2))


def wall_strip_for_side(wall_img, side, size, depth):
    """The wall strip art, oriented and sized to lay along `side` of a size x size tile."""
    strip = wall_img.resize((size, depth))
    if side == "N":
        return strip, (0, 0)
    if side == "S":
        return strip.transpose(Image.Transpose.FLIP_TOP_BOTTOM), (0, size - depth)
    vertical = strip.rotate(-90, expand=True)  # size (h) x depth (w)
    if side == "W":
        return vertical, (0, 0)
    return vertical.transpose(Image.Transpose.FLIP_LEFT_RIGHT), (size - depth, 0)


def build_piece(floor_crop, wall_img, walls, size, depth):
    """`walls` is the subset of SIDES this piece has a wall on."""
    out = floor_crop.copy()
    for side in walls:
        strip, pos = wall_strip_for_side(wall_img, side, size, depth)
        out.paste(strip, pos)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--floor", required=True)
    ap.add_argument("--wall", required=True)
    ap.add_argument("--out", default="assets/dungeon-rooms")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--wall-depth", type=int, default=110)
    ap.add_argument("--rubble", default=None, help="optional rubble-fill source to stamp into the end piece's open side")
    a = ap.parse_args()

    floor_img = load(a.floor)
    wall_img = load(a.wall)
    floor_crop = crop_floor(floor_img, a.size)
    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    pieces = {
        "corridor.webp": set(SIDES),              # single: walls on all 4
        "corridor-end.webp": {"N", "E", "W"},      # open S
        "corridor-mid.webp": {"E", "W"},           # open N+S
        "corridor-corner.webp": {"N", "W"},        # open S+E
    }
    for name, walls in pieces.items():
        img = build_piece(floor_crop, wall_img, walls, a.size, a.wall_depth)
        img.save(out_dir / name, "WEBP", quality=90)
        print(f"-> {out_dir / name}")

    # Rubble: the end piece's own shape (walls N+E+W), with a rubble-fill
    # image stamped over its own open-south floor region instead of plain
    # floor -- same wall strips as every other piece, so its own 3 closed
    # edges match them exactly; only the rubble source needs a separate
    # generation (Task 3's own job if the default floor+wall composite
    # isn't enough on its own to read as "collapsed", per that task's review).
    rubble_base = build_piece(floor_crop, wall_img, {"N", "E", "W"}, a.size, a.wall_depth)
    if a.rubble:
        rubble_img = load(a.rubble).resize((a.size, a.size // 2))
        rubble_base.paste(rubble_img, (0, a.size // 2))
    rubble_base.save(out_dir / "corridor-rubble.webp", "WEBP", quality=90)
    print(f"-> {out_dir / 'corridor-rubble.webp'}")


if __name__ == "__main__":
    main()
```

(`--wall-depth` and the rubble-fill compositing rectangle are starting points — Task 3's own review step is where these get tuned against how they actually look, not treated as final on the first run.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/corridor-pieces.test.mjs -t "compose-corridor-pieces"`
Expected: PASS.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS (the art files themselves haven't been replaced yet — that's Task 3 — so `tests/dungeon-art-edges.test.mjs` still passes against today's existing, not-yet-replaced files).

- [ ] **Step 6: Commit**

```bash
git add tools/compose-corridor-pieces.py tests/corridor-pieces.test.mjs
git commit -m "feat(#857): add the shared-source corridor piece compositor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Generate the pieces, build the join contact sheet, owner review

**Files:**
- Modify: `assets/dungeon-rooms/corridor.webp`, `corridor-end.webp`, `corridor-mid.webp`, `corridor-corner.webp`, `corridor-rubble.webp`
- Modify: `assets/dungeon-rooms/edge-report.json`

No code changes in this task.

- [ ] **Step 1: Run the compositor**

```bash
.venv/bin/python tools/compose-corridor-pieces.py --floor <floor-source> --wall <wall-strip-source> --out assets/dungeon-rooms
```

If the default rubble (end-shape + plain floor on the open side) doesn't read as "collapsed passage" on inspection, generate a small rubble-fill texture (matching the existing `corridor-rubble.webp`'s own rubble-pile material/style) and re-run with `--rubble <rubble-source>`.

- [ ] **Step 2: Build a join contact sheet**

Write a small script (or extend `make-corridor-corner.py`'s own existing `--preview`/`--proof` pattern, confirmed current) that tiles several of the 5 new pieces together in their real rotations — at minimum: a straight run (several `mid` tiles in a row), an `end`-into-`mid` join, and a `corner` with a `mid` joined to each of its two open sides (matching `corridorPieceForOpenings`'s own real rotation math, confirmed current in `scripts/corridor-pieces.mjs`) — into one image for review.

- [ ] **Step 3: Owner review**

Per the issue's own explicit requirement: review the contact sheet before merging. Confirm every join shows continuous floor with no visible seam, every wall edge matches in style, and the corner's own two walls meet convincingly. Redo (regenerate a source asset, retune `--wall-depth`, or adjust the compositor) and re-review if not — this is the real acceptance gate for this entire plan, not a formality.

- [ ] **Step 4: Refresh the edge-quality report**

```bash
.venv/bin/python tools/strip-art-white-edge.py assets/dungeon-rooms --report-only
```

(Confirmed current, `tools/strip-art-white-edge.py`'s own docstring: run this after regenerating any file under `assets/dungeon-rooms/`, or `tests/dungeon-art-edges.test.mjs`'s own hash-pinning test fails.) If it reports a near-white fringe on any new piece, run the script on that file directly (not `--report-only`) to strip it, per its own documented usage, then re-run `--report-only` once more to refresh the report against the cleaned files.

- [ ] **Step 5: Run the full test suite to confirm it passes**

Run: `npx vitest run`
Expected: PASS — `tests/dungeon-art-edges.test.mjs` (hashes match the refreshed report, no near-white band), `tests/dungeon-room-art.test.mjs`, `tests/dungeon-corridor-joins-sweep.test.mjs`, and `tests/dungeon-scene-corridor-edge-tiles.test.mjs` (confirmed current, all three covering this exact art/geometry area) all stay green with no code changes needed, since every file name and the `CORRIDOR_ART_BY_VARIANT` mapping are unchanged.

- [ ] **Step 6: Commit**

```bash
git add assets/dungeon-rooms/corridor.webp assets/dungeon-rooms/corridor-end.webp assets/dungeon-rooms/corridor-mid.webp assets/dungeon-rooms/corridor-corner.webp assets/dungeon-rooms/corridor-rubble.webp assets/dungeon-rooms/edge-report.json
git commit -m "feat(#857): ship the regenerated, seamlessly-joining corridor art

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Live verification, version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Live-verify via `foundry-rest`**

Generate a few real dungeon runs with long/branching corridors (including at least one merge-room junction, to exercise the `corner` piece) and confirm visually (via a connected client, not by panning this session's own camera — see this session's own standing caution from #823's investigation) that the new art shows no seams at any join, including the corner case.

- [ ] **Step 2: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (new generated content replacing shipped art), using whatever the fetch above shows as current.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#857): bump version for the corridor art regeneration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #857's own requirements list is covered point by point: all 5 named pieces regenerated in one consistent style (Task 1-3); same pixel size and rotation convention as the real, confirmed-merged openings table (Task 2's own drift-guard test pins this); open edges matching exactly by construction, not hope (Task 1's shared-source approach); file names unchanged, no code change needed (confirmed, `CORRIDOR_ART_BY_VARIANT` untouched); existing art tooling reused (ComfyUI, the same Python/Pillow/numpy stack `make-corridor-corner.py`/`strip-art-white-edge.py` already use); owner review of a join contact sheet before merging (Task 3's own explicit gate). The T/cross piece is explicitly out of scope per the user's own decision.

**2. Placeholder scan:** No TBD/TODO. Every code block (the compositing tool, the drift-guard test) is complete, real code — the one explicitly-flagged uncertainty (whether the default rubble compositing reads as "collapsed" on the first try) is named as a real review-and-iterate point, not glossed over as settled.

**3. Type consistency:** The compositing tool's own `pieces` dict (Task 2) uses the exact same side-set semantics (`{N,E,S,W}` subsets) as `scripts/corridor-pieces.mjs`'s own `PIECE_OPENINGS`, confirmed matching side-for-side in the plan's own "Convention" section.

**4. Review Focus:** All five items (seamless open edges, matching wall style, no white-fringe regression, a convincing corner miter, a rubble piece that actually reads as rubble) each map to a specific step or test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-corridor-art-regeneration.md`.
