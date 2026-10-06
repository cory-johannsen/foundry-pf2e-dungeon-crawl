# Corridor Joins, Corner Piece and Tile Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #823 — corridor tiles connect visually where the corridor is open (no wall drawn across a joint, no fully-walled box hiding a crossing), bends get a proper corner piece, and no two corridor tiles stack on one cell.

**Supersedes:** `docs/superpowers/plans/2026-10-06-corridor-tile-merge-dedup.md` (#849). That plan's merge-room dedup was implemented and reviewed: on the live pipeline (layout v3 + topology routing) it changed nothing (23,341 tiles and 1,257 stacked cells both before and after over 100 seeds), because the live stacks come from the transit-cell site and from repeated end caps inside one corridor, not from merge rooms. That unmerged branch was discarded.

**Root cause (measured on origin/main `6acd4e43`, 100 seeds, routed v3 = the live default):**
`corridorTileVariant` (`scripts/dungeon-layout.mjs` ~2018) puts an `end` cap at BOTH ends of every straight segment, including where a corridor continues into the next transit cell or turns a corner. Each cap draws a wall across what is really an open corridor (no wall *document* exists there: walls are separate documents, tiles are visual only). The segments also overlap at their joins, so 1,257 cells hold two stacked tiles: 578 main+transit (a connector leg's `max(1,…)` cell lands inside the transit cell), 524 transit+transit (both legs of an L-shaped crossing include the corner cell, #355), 153 main+main same-edge, 2 cross-edge. The art set has no corner piece, so a bend can never look right.
Live examples confirmed by the owner: tile `DcaNm4P48nlp0HZ0` (`corridor-end@90`) and `MjdJrGrgzUxF4u9d` (`corridor-end@0`) are side-adjacent end caps of one corridor that look walled off but are not; tile `f52ddudmaSStX7nd` (`corridor.webp`, a fully walled box) sits on top of a transit end cap.

**Architecture:** Choose each corridor cell's piece from its **openings** = which of its four sides continue to another cell of the SAME corridor (the corridor's own cell set, de-duplicated). 0 openings → `single`; 1 → `end` (wall opposite the opening, so a door end keeps today's look); 2 opposite → `mid`; 2 adjacent → NEW `corner`; 3+ → fallback `mid` along the first opposite pair (a visual limitation, see Decisions). A pure `corridorPieceForOpenings` does the lookup; `corridorEdgeTiles` builds one corridor's de-duplicated cell set (transit crossings claim shared cells first so their marker tile survives) and returns the tiles for the room-build call and for each transit crossing; a small scene-wide guard drops a tile whose cell an earlier corridor tile already holds. `corridorTilesForSegments` and its `cells` output stay unchanged so #779's trap placement does not move.

**Tech Stack:** Vanilla ES modules, Vitest, Python + Pillow (one-off art composition script).

**Spec:** None — design presented in chat and approved by the owner (2026-10-06, including: include a new corner art piece, code + asset together).

## Decisions made while planning (record on the issue)

- **Door cells keep today's look.** A door-end cell has exactly one same-corridor neighbour, so it gets an `end` cap (wall toward the room, door cut in it by the wall document) as before. (Alternative considered: count the door side as an opening so door cells become mid/corner — rejected to keep the approved design; 203 of 2,844 routed door ends approach the door sideways and keep today's side wall, unchanged.)
- **Overshoot cells inside the destination room are NOT touched** (370 per 100 seeds; the #779 overshoot). They get the same rule as any cell. A follow-up ticket should handle them.
- **3+ openings** (1 routed cell per 100 seeds, from a cross-edge detour overlap; 699 in legacy unrouted v3) use a straight `mid` along the first opposite pair (N–S preferred, else E–W). Visual limitation only; no new asset.
- **Wide corridors** (#555 `fullWidth`/`cross>1`, only in legacy unrouted v3, 0 in routed) are detected as any fully occupied 2×2 block in the corridor's cell set and keep today's pieces untouched.
- **Cross-edge collisions** (2 per 100 routed seeds) use first-wins: a later corridor tile on an already-held corridor cell is dropped, never merged; a transit crossing never loses ALL its tiles (its marker tile must survive), in that rare case one tile stays and the stack remains.
- **Out of scope, file as follow-ups:** the overshoot cells inside rooms; hidden west-face detour entries whose last leg runs down the destination room's own first column or through another room (27/12/17 cases per 100 seeds).

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version`. This is a larger rendering change plus a new asset: **minor** bump. Take the highest of `origin/main`'s version and any open PR's version, bump its minor, never reuse a number (three collisions have already happened on this repo); re-check right before committing and after any rebase.
- Tiles are visual only. Do not change wall geometry, door documents, pathfinding, `buildEdgeCorridor`, or `corridorTilesForSegments`'s return shape (`{tiles, cells}`) — `corridorTrapCandidateCells(edgeCells, …)` (#779) must keep reading the unfiltered cells.
- Rotation convention: Foundry tile rotation is clockwise degrees about the tile centre. Openings table (side order N,E,S,W):
  - `single`: none. `end@0`: S; `end@90`: W; `end@180`: N; `end@270`: E.
  - `mid@0` (= @180): N,S; `mid@90` (= @270): E,W.
  - `corner@0` (canonical: walls N+W): S,E; `corner@90`: S,W; `corner@180`: N,W; `corner@270`: N,E.
  - This matches `corridorTileVariant`'s comments and the live pair above (verified: a vertical gallery's near end is `end@0` with the wall at N; a horizontal gallery's near end is `end@270`, far end `end@90`).
- New files must go through the `update-architecture-docs` skill (new import edges, group placement in `tools/generate-architecture-graph.mjs`).
- The corner art is subjective: **the owner approves the image before anything else merges** (Task 1 ends with an approval gate).

## Review Focus

- **No wall is drawn across an open joint**: for every pair of consecutive cells of one corridor, both tiles are open toward each other (invariant I2 below). A *symmetric* check ("A open toward B iff B open toward A") is NOT enough — two closed caps facing each other is symmetric and passes; this was the live bug.
- **No stacked corridor tiles anywhere in the live pipeline** (routed v3), except the documented rare transit-marker case.
- **A door end keeps its `end` cap** with the wall toward the room, and a one-cell corridor stays `single`.
- **Transit crossings still create at least one tile carrying the `dungeonTransitCellCrossing` marker** (idempotency, `alreadyBuilt`).
- **#779 trap placement is unaffected** (it reads the unfiltered `edgeCells`).
- **Wide (#555) corridors and 3+-opening cells do not crash or produce a missing tile.**
- **Every re-pinned golden number is explained** (what the digest covers and why it must change); walls must be shown unchanged.

---

### Task 1: The corner art piece (ends with an owner approval gate)

**Files:**
- Create: `tools/make-corridor-corner.py`
- Create: `assets/dungeon-rooms/corridor-corner.webp`
- Modify: `tests/dungeon-room-art.test.mjs` (add the new asset to the expected list, ~line 30)

**Interfaces:** Produces `assets/dungeon-rooms/corridor-corner.webp`, canonical orientation **walls on N and W, open on S and E**, same pixel size and style as `corridor.webp`/`corridor-mid.webp`/`corridor-end.webp` (all top-down stone corridor cells, 512×512 — confirm).

Pieces for reference (top-down view; viewed by the planner): `corridor.webp` = walls on all four sides; `corridor-end.webp` = U, walls N+W+E, open S; `corridor-mid.webp` = walls W+E, open N+S (rotate 90° for E–W). The floor slab pattern is continuous through the open sides.

- [ ] **Step 1: Set up the tooling**

Pillow is not installed. In the worktree: `python3 -m venv .venv && .venv/bin/pip install pillow numpy` (`.venv/` is gitignored — confirm with `git check-ignore .venv`; never commit it). If network is unavailable, stop and report BLOCKED.

- [ ] **Step 2: Write `tools/make-corridor-corner.py`**

Compose the corner deterministically from the existing pieces (no image generation — a fresh generation would not match the existing style). Baseline algorithm (iterate visually, see Step 3): load `corridor.webp` (S), `corridor-mid.webp` (M), `corridor-end.webp` (E); build four 256×256 quadrants of the output:
- top-left from S (it has both the N and W walls and their meeting corner),
- top-right from M rotated 90° clockwise (`Image.Transpose.ROTATE_270` in PIL — PIL's `rotate` is counter-clockwise; Foundry's rotation is clockwise) — N wall with an open E edge,
- bottom-left from M unrotated — W wall with an open S edge,
- bottom-right: open floor — crop an interior floor patch from M's central band (no wall pixels), resized only if needed so slab lines keep their scale.
Blend the quadrant seams with a ~24px feathered alpha mask so slab lines and lighting do not step. Save as WebP at the same quality/size as the sources. The script takes `--src assets/dungeon-rooms --out assets/dungeon-rooms/corridor-corner.webp` and also writes `--preview <dir>/corner-preview.png`, a contact sheet showing the corner at all four rotations (0/90/180/270, rotated clockwise) next to a `mid` piece joined to each open side, so seams and mismatches are visible.

```python
#!/usr/bin/env python3
"""Compose assets/dungeon-rooms/corridor-corner.webp (#823) from the existing
corridor pieces: walls on N+W, open on S+E (canonical; the module rotates it)."""
import argparse
from pathlib import Path
from PIL import Image, ImageFilter

def load(src, name):
    return Image.open(Path(src) / name).convert("RGBA")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="assets/dungeon-rooms")
    ap.add_argument("--out", default="assets/dungeon-rooms/corridor-corner.webp")
    ap.add_argument("--preview", default=None)
    a = ap.parse_args()
    single, mid = load(a.src, "corridor.webp"), load(a.src, "corridor-mid.webp")
    n = single.size[0]
    h = n // 2
    mid_h = mid.transpose(Image.Transpose.ROTATE_270)  # clockwise 90: walls N+S, open E+W
    out = Image.new("RGBA", (n, n))
    out.paste(single.crop((0, 0, h, h)), (0, 0))            # TL: N+W walls
    out.paste(mid_h.crop((h, 0, n, h)), (h, 0))             # TR: N wall, open E
    out.paste(mid.crop((0, h, h, n)), (0, h))               # BL: W wall, open S
    # BR: open floor from the middle of the straight piece (no wall pixels)
    floor = mid.crop((n // 4, n // 4, n // 4 + h, n // 4 + h))
    out.paste(floor, (h, h))
    # feather the quadrant seams: blur a thin cross-shaped band and re-composite
    band = Image.new("L", (n, n), 0)
    for x in range(h - 12, h + 12):
        for y in range(n):
            band.putpixel((x, y), 255)
    for y in range(h - 12, h + 12):
        for x in range(n):
            band.putpixel((x, y), 255)
    blurred = out.filter(ImageFilter.GaussianBlur(6))
    out = Image.composite(blurred, out, band.filter(ImageFilter.GaussianBlur(8)))
    out.save(a.out, "WEBP", quality=92)
    if a.preview:
        sheet = Image.new("RGBA", (n * 4, n * 2), (0, 0, 0, 255))
        for i, rot in enumerate((0, 90, 180, 270)):
            sheet.paste(out.rotate(-rot), (i * n, 0))   # PIL rotate is CCW; negative = CW
            sheet.paste(mid, (i * n, n))
        sheet.convert("RGB").save(a.preview)

if __name__ == "__main__":
    main()
```

(The code above is the **baseline only**. The pixel-level result is subjective; Step 3 iterates it. Replace the naive per-pixel `putpixel` loops with array operations (numpy or `Image.paste` with a mask) if they are slow.)

- [ ] **Step 3: Generate, look, iterate (max 6 rounds)**

Run `.venv/bin/python tools/make-corridor-corner.py --preview /tmp/<scratchpad>/corner-preview.png`, then LOOK at the preview image (the Read tool shows images). Acceptance criteria, all required:
1. Walls are present ONLY on the N and W sides; the S and E sides are open floor, with no wall strip or bevel remnants.
2. The N+W wall corner reads as a proper inside corner (no seam, no doubled bevel).
3. At each open edge (S and E) the floor and the side-wall continuation line up with how `corridor-mid` meets a neighbour: place the corner's open edge next to a `mid` piece in the preview and confirm there is no visible step in slab lines or lighting.
4. The four rotations in the contact sheet look like the same piece turned, not four different assets.
Fix the script and re-run until all four hold. If after 6 rounds it still shows seams, STOP and report NEEDS_CONTEXT with the preview; do not invent a different approach.

- [ ] **Step 4: Add the asset test**

In `tests/dungeon-room-art.test.mjs`, add `'corridor-corner.webp'` to the asset list the test checks (look at how `corridor-end.webp`/`corridor-mid.webp` are listed and mirror it). Also add a size check if that file does one for the other corridor pieces.

Run: `npx vitest run tests/dungeon-room-art.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit, then OWNER APPROVAL GATE**

```bash
git add tools/make-corridor-corner.py assets/dungeon-rooms/corridor-corner.webp tests/dungeon-room-art.test.mjs
git commit -m "feat(#823): corridor corner art piece

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**STOP HERE.** The controller shows the owner `corner-preview.png` (all four rotations beside a straight piece) and does not start Task 2 until the owner approves the look. If the owner asks for changes, repeat Step 3 and re-commit.

---

### Task 2: Pure piece selection

**Files:**
- Create: `scripts/corridor-pieces.mjs`
- Test: `tests/corridor-pieces.test.mjs`

**Interfaces:**
- Produces: `PIECE_OPENINGS` (table above, keyed `variant@rotation`), `corridorPieceForOpenings(openings: Iterable<'N'|'E'|'S'|'W'>): {variant: 'single'|'end'|'mid'|'corner', rotation: 0|90|180|270}`, `openingsOf(cell: {gx,gy}, cellSet: Set<string>): Array<'N'|'E'|'S'|'W'>`, `cellKey({gx,gy}): string` (`"gx,gy"`), `hasBlock2x2(cellSet): boolean`.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import {
  PIECE_OPENINGS,
  corridorPieceForOpenings,
  openingsOf,
  cellKey,
  hasBlock2x2,
} from '../scripts/corridor-pieces.mjs';

const sorted = (a) => [...a].sort().join('');

describe('corridorPieceForOpenings', () => {
  it('maps every opening set to a piece whose openings match (round trip)', () => {
    const sets = [[], ['N'], ['E'], ['S'], ['W'], ['N', 'S'], ['E', 'W'],
      ['S', 'E'], ['S', 'W'], ['N', 'W'], ['N', 'E']];
    for (const open of sets) {
      const { variant, rotation } = corridorPieceForOpenings(open);
      const key = variant === 'single' ? 'single' : `${variant}@${rotation}`;
      expect(sorted(PIECE_OPENINGS[key]), JSON.stringify(open)).toBe(sorted(open));
    }
  });

  it('uses end caps with the wall opposite the single opening (door ends keep today\'s look)', () => {
    expect(corridorPieceForOpenings(['S'])).toEqual({ variant: 'end', rotation: 0 });
    expect(corridorPieceForOpenings(['W'])).toEqual({ variant: 'end', rotation: 90 });
    expect(corridorPieceForOpenings(['N'])).toEqual({ variant: 'end', rotation: 180 });
    expect(corridorPieceForOpenings(['E'])).toEqual({ variant: 'end', rotation: 270 });
  });

  it('uses single for no openings, mid for opposite pairs, corner for adjacent pairs', () => {
    expect(corridorPieceForOpenings([])).toEqual({ variant: 'single', rotation: 0 });
    expect(corridorPieceForOpenings(['N', 'S'])).toEqual({ variant: 'mid', rotation: 0 });
    expect(corridorPieceForOpenings(['E', 'W'])).toEqual({ variant: 'mid', rotation: 90 });
    expect(corridorPieceForOpenings(['S', 'E'])).toEqual({ variant: 'corner', rotation: 0 });
    expect(corridorPieceForOpenings(['S', 'W'])).toEqual({ variant: 'corner', rotation: 90 });
    expect(corridorPieceForOpenings(['N', 'W'])).toEqual({ variant: 'corner', rotation: 180 });
    expect(corridorPieceForOpenings(['N', 'E'])).toEqual({ variant: 'corner', rotation: 270 });
  });

  it('falls back to a straight mid for 3+ openings (T / cross), N-S preferred', () => {
    expect(corridorPieceForOpenings(['N', 'E', 'S'])).toEqual({ variant: 'mid', rotation: 0 });
    expect(corridorPieceForOpenings(['E', 'S', 'W'])).toEqual({ variant: 'mid', rotation: 90 });
    expect(corridorPieceForOpenings(['N', 'E', 'S', 'W'])).toEqual({ variant: 'mid', rotation: 0 });
  });

  it('is order-independent', () => {
    expect(corridorPieceForOpenings(['E', 'S'])).toEqual(corridorPieceForOpenings(['S', 'E']));
  });
});

describe('openingsOf / hasBlock2x2', () => {
  const set = (...cells) => new Set(cells.map(([gx, gy]) => cellKey({ gx, gy })));

  it('reports the sides whose neighbour is in the set', () => {
    const cells = set([1, 1], [1, 2], [2, 1]);
    expect(sorted(openingsOf({ gx: 1, gy: 1 }, cells))).toBe('ES'); // east (2,1), south (1,2)
    expect(sorted(openingsOf({ gx: 2, gy: 1 }, cells))).toBe('W');
  });

  it('detects a fully occupied 2x2 block only', () => {
    expect(hasBlock2x2(set([0, 0], [1, 0], [0, 1], [1, 1]))).toBe(true);
    expect(hasBlock2x2(set([0, 0], [1, 0], [0, 1]))).toBe(false);
    expect(hasBlock2x2(set([0, 0], [1, 0], [2, 0]))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/corridor-pieces.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```js
/**
 * #823: corridor piece selection from OPENINGS. A corridor cell's piece is
 * decided by which of its four sides continue to another cell of the SAME
 * corridor, not by which end of a straight segment it sits at (the old
 * corridorTileVariant put an end cap at both ends of every segment, which
 * drew a wall across every join and bend). Foundry-free and pure.
 *
 * Rotation is clockwise degrees about the tile centre. Canonical pieces:
 * end@0 open S; mid@0 open N+S; corner@0 walls N+W, open S+E.
 */
export const PIECE_OPENINGS = {
  single: [],
  'end@0': ['S'], 'end@90': ['W'], 'end@180': ['N'], 'end@270': ['E'],
  'mid@0': ['N', 'S'], 'mid@90': ['E', 'W'],
  'corner@0': ['S', 'E'], 'corner@90': ['S', 'W'],
  'corner@180': ['N', 'W'], 'corner@270': ['N', 'E'],
};

const END_ROTATION_BY_OPENING = { S: 0, W: 90, N: 180, E: 270 };
const CORNER_ROTATION_BY_PAIR = { ES: 0, SW: 90, NW: 180, EN: 270 };
const SIDE_DELTA = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

export function cellKey(cell) {
  return `${cell.gx},${cell.gy}`;
}

/** The sides of `cell` whose neighbour cell is in `cellSet` (keys from cellKey). */
export function openingsOf(cell, cellSet) {
  return Object.entries(SIDE_DELTA)
    .filter(([, [dx, dy]]) => cellSet.has(cellKey({ gx: cell.gx + dx, gy: cell.gy + dy })))
    .map(([side]) => side);
}

/** True when any 2x2 block of cells is fully occupied: a wide (#555) corridor. */
export function hasBlock2x2(cellSet) {
  for (const key of cellSet) {
    const [gx, gy] = key.split(',').map(Number);
    if (
      cellSet.has(cellKey({ gx: gx + 1, gy })) &&
      cellSet.has(cellKey({ gx, gy: gy + 1 })) &&
      cellSet.has(cellKey({ gx: gx + 1, gy: gy + 1 }))
    )
      return true;
  }
  return false;
}

/** The art variant + rotation for a cell with these openings. 3+ openings
 * (a T or cross where two corridors share a cell) have no dedicated art: a
 * straight `mid` along the first opposite pair (N-S preferred) is used. */
export function corridorPieceForOpenings(openings) {
  const open = new Set(openings);
  const n = open.size;
  if (n === 0) return { variant: 'single', rotation: 0 };
  if (n === 1) return { variant: 'end', rotation: END_ROTATION_BY_OPENING[[...open][0]] };
  if (n === 2) {
    if (open.has('N') && open.has('S')) return { variant: 'mid', rotation: 0 };
    if (open.has('E') && open.has('W')) return { variant: 'mid', rotation: 90 };
    const pair = [...open].sort().join('');
    return { variant: 'corner', rotation: CORNER_ROTATION_BY_PAIR[pair] };
  }
  return open.has('N') && open.has('S')
    ? { variant: 'mid', rotation: 0 }
    : { variant: 'mid', rotation: 90 };
}
```

Note the `CORNER_ROTATION_BY_PAIR` keys use the alphabetically sorted pair: `['S','E']` sorts to `ES`, `['S','W']` to `SW`, `['N','W']` to `NW`, `['N','E']` to `EN`. Verify against the tests before committing.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/corridor-pieces.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/corridor-pieces.mjs tests/corridor-pieces.test.mjs
git commit -m "feat(#823): pure corridor piece selection from openings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Build a corridor's tiles from its de-duplicated cell set

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (extract `corridorTileAt`; add `corridorEdgeTiles`; add `corner` to `CORRIDOR_ART_BY_VARIANT`)
- Test: `tests/dungeon-scene-corridor-edge-tiles.test.mjs` (new)

**Interfaces:**
- Consumes: `corridorPieceForOpenings`, `openingsOf`, `cellKey`, `hasBlock2x2` (Task 2); the existing `corridorTilesForSegments(segments, {fullWidth})`.
- Produces: `corridorTileAt(gx, gy, variant, rotation)` — the exact tile object `corridorTilesForSegments` builds today for one cell (centre-anchored, 100×100, `texture.src = CORRIDOR_ART_BY_VARIANT[variant]`); `corridorEdgeTiles({corridorSegments, transitCells}, {fullWidth}): {main: Tile[], transit: Tile[][], mainCells: Cell[], legacy: boolean}` — `transit[i]` are the tiles for `transitCells[i]` (same order); `mainCells` is the UNFILTERED cell list from `corridorTilesForSegments(corridorSegments)` (what #779's trap picks keep reading); `legacy` is true when a 2×2 block was found and today's pieces were returned unchanged.

- [ ] **Step 1: Refactor for reuse (no behaviour change)**

In `corridorTilesForSegments`, extract the tile-object literal (centre anchor, `x/y = toPixels(cell)+toPixels(1)/2`, size `toPixels(1)`, `rotation`, `texture.src = CORRIDOR_ART_BY_VARIANT[variant]`, `anchorX/anchorY: 0.5`) into `export function corridorTileAt(gx, gy, variant, rotation)` and call it from the segment loop. Keep every comment about the centre anchor (#324) on the extracted function. Add `corner: \`${ROOM_ART_DIR}/corridor-corner.webp\`` to `CORRIDOR_ART_BY_VARIANT`. Run the existing suite for this file: `npx vitest run tests/dungeon-scene.test.mjs` — must stay green with NO change (pure refactor).

- [ ] **Step 2: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { corridorEdgeTiles, corridorTileAt } from '../scripts/dungeon-scene.mjs';

const piece = (tile) => `${tile.texture.src.split('/').pop().replace('.webp', '')}@${tile.rotation}`;
const at = (tiles, gx, gy) =>
  tiles.find((t) => t.x === gx * 100 + 50 && t.y === gy * 100 + 50);

describe('corridorEdgeTiles (#823)', () => {
  it('a straight horizontal corridor is end, mid..., end with the walls at the ends', () => {
    const { main } = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 5, gw: 4, gh: 1 }],
      transitCells: [],
    });
    expect(main.map(piece)).toEqual(['corridor-end@270', 'corridor-mid@90', 'corridor-mid@90', 'corridor-end@90']);
  });

  it('an L-shaped corridor (two segments sharing the corner cell) gets ONE corner tile there, no stack', () => {
    // horizontal leg (0..3, 5) then vertical leg (3, 5..8): corner cell (3,5)
    const { main } = corridorEdgeTiles({
      corridorSegments: [
        { gx: 0, gy: 5, gw: 4, gh: 1 },
        { gx: 3, gy: 5, gw: 1, gh: 4 },
      ],
      transitCells: [],
    });
    const keys = main.map((t) => `${t.x},${t.y}`);
    expect(new Set(keys).size).toBe(keys.length); // no stacked tiles
    expect(piece(at(main, 3, 5))).toBe('corridor-corner@90'); // open W (from 2,5) and S (to 3,6)
    expect(piece(at(main, 0, 5))).toBe('corridor-end@270');
    expect(piece(at(main, 3, 8))).toBe('corridor-end@180'); // wall at S end
  });

  it('two side-adjacent cells that belong to different owners join with mid pieces (the live sealed-looking pair)', () => {
    // main corridor (0..1, 5) continues into a transit crossing covering (2..3, 5)
    const { main, transit } = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 5, gw: 2, gh: 1 }],
      transitCells: [{ corridorSegments: [{ gx: 2, gy: 5, gw: 2, gh: 1 }] }],
    });
    expect(piece(at(main, 1, 5))).toBe('corridor-mid@90'); // was an end cap facing the transit cell
    expect(piece(at(transit[0], 2, 5))).toBe('corridor-mid@90');
    expect(piece(at(transit[0], 3, 5))).toBe('corridor-end@90');
  });

  it('a cell shared by main and transit is owned by the transit crossing (so its marker tile survives)', () => {
    const { main, transit } = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 5, gw: 3, gh: 1 }],
      transitCells: [{ corridorSegments: [{ gx: 2, gy: 5, gw: 2, gh: 1 }] }],
    });
    expect(at(main, 2, 5)).toBeUndefined();
    expect(at(transit[0], 2, 5)).toBeDefined();
    const all = [...main, ...transit.flat()].map((t) => `${t.x},${t.y}`);
    expect(new Set(all).size).toBe(all.length);
  });

  it('a one-cell corridor stays single', () => {
    const { main } = corridorEdgeTiles({
      corridorSegments: [{ gx: 4, gy: 4, gw: 1, gh: 1 }],
      transitCells: [],
    });
    expect(main.map(piece)).toEqual(['corridor@0']);
  });

  it('a wide corridor (2x2 block) keeps today\'s pieces untouched (legacy)', () => {
    const r = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 0, gw: 2, gh: 2 }],
      transitCells: [],
    });
    expect(r.legacy).toBe(true);
  });

  it('mainCells is the UNFILTERED cell list (#779 trap placement reads it)', () => {
    const r = corridorEdgeTiles({
      corridorSegments: [
        { gx: 0, gy: 5, gw: 4, gh: 1 },
        { gx: 3, gy: 5, gw: 1, gh: 4 },
      ],
      transitCells: [],
    });
    expect(r.mainCells.length).toBeGreaterThan(r.main.length); // the shared corner appears twice in mainCells
  });

  it('every transit crossing keeps at least one tile (marker safety)', () => {
    const { transit } = corridorEdgeTiles({
      corridorSegments: [{ gx: 0, gy: 5, gw: 2, gh: 1 }],
      transitCells: [
        { corridorSegments: [{ gx: 2, gy: 5, gw: 2, gh: 1 }] },
        { corridorSegments: [{ gx: 2, gy: 5, gw: 2, gh: 1 }] }, // an identical crossing
      ],
    });
    expect(transit[0].length).toBeGreaterThan(0);
    expect(transit[1].length).toBeGreaterThan(0);
  });
});
```

(Adjust the segment fixtures if `corridorTilesForSegments` derives `vertical`/`length` differently from the sketch — read it and make the fixtures real. The assertions describe the required outcomes; the cell coordinates are the part to verify.)

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/dungeon-scene-corridor-edge-tiles.test.mjs`
Expected: FAIL — `corridorEdgeTiles` is not exported.

- [ ] **Step 4: Implement `corridorEdgeTiles`**

In `scripts/dungeon-scene.mjs` (imports: `corridorPieceForOpenings, openingsOf, cellKey, hasBlock2x2` from `./corridor-pieces.mjs`):

```js
/**
 * #823: all of ONE corridor's tiles, chosen from the corridor's own cell set
 * so a join or bend never draws a wall across an open joint and no cell holds
 * two tiles. `corridorSegments` are the room-build call's main legs;
 * `transitCells` the crossings (each with its own `corridorSegments`).
 * A cell present in more than one place (a main leg overlapping a crossing,
 * both legs of an L-shaped crossing sharing the corner, #355) is owned once:
 * crossings claim first, in order, then the main legs, so each crossing's
 * marker tile survives. A cell's piece comes from which sides continue to
 * another cell of this same corridor (corridor-pieces.mjs). A wide (#555)
 * corridor keeps today's pieces. `mainCells` stays the unfiltered list
 * #779's trap placement reads.
 */
export function corridorEdgeTiles({ corridorSegments, transitCells = [] }, { fullWidth = false } = {}) {
  const main = corridorTilesForSegments(corridorSegments, { fullWidth });
  const transits = transitCells.map((c) => corridorTilesForSegments(c.corridorSegments));

  const owner = new Map(); // cellKey -> 'main' | transit index
  const order = []; // [{cell, owner}] in claim order
  const claim = (cells, who) => {
    for (const cell of cells) {
      const key = cellKey(cell);
      if (owner.has(key)) continue;
      owner.set(key, who);
      order.push({ cell, owner: who });
    }
  };
  transits.forEach((t, i) => claim(t.cells, i));
  claim(main.cells, 'main');

  const cellSet = new Set(owner.keys());
  if (hasBlock2x2(cellSet)) {
    return { main: main.tiles, transit: transits.map((t) => t.tiles), mainCells: main.cells, legacy: true };
  }

  const result = {
    main: [],
    transit: transits.map(() => []),
    mainCells: main.cells,
    legacy: false,
  };
  for (const { cell, owner: who } of order) {
    const { variant, rotation } = corridorPieceForOpenings(openingsOf(cell, cellSet));
    const tile = corridorTileAt(cell.gx, cell.gy, variant, rotation);
    (who === 'main' ? result.main : result.transit[who]).push(tile);
  }
  // A crossing must keep at least one tile (its marker lives on its tiles):
  // if every cell was claimed earlier, re-add its first cell (a rare stack).
  transits.forEach((t, i) => {
    if (!result.transit[i].length && t.cells[0]) {
      const cell = t.cells[0];
      const { variant, rotation } = corridorPieceForOpenings(openingsOf(cell, cellSet));
      result.transit[i].push(corridorTileAt(cell.gx, cell.gy, variant, rotation));
    }
  });
  return result;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/dungeon-scene-corridor-edge-tiles.test.mjs tests/dungeon-scene.test.mjs`
Expected: PASS (the refactor left every existing test green).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-corridor-edge-tiles.test.mjs
git commit -m "feat(#823): build a corridor's tiles from its de-duplicated cell set

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire it into the scene builders, with the cross-edge guard

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`buildPopulateAndUnlockGraphNode`'s `incomingConnections` loop ~1775-1901; `buildTransitCellIfNeeded` ~321; new `corridorCellKeyOfTile`/`skipClaimedCorridorTiles`)
- Test: `tests/dungeon-scene-corridor-edge-tiles.test.mjs` (guard unit tests), plus the sweep in Task 5

**Interfaces:**
- Consumes: `corridorEdgeTiles` (Task 3).
- Produces: `corridorCellKeyOfTile(tile): string|null` (`"gx,gy"` from a corridor tile's centre x/y, null for non-corridor art), `skipClaimedCorridorTiles(tiles, claimed: Set<string>, {keepOne = false}): Tile[]` — returns the tiles whose cell is not already in `claimed` (and adds the kept cells to `claimed`); with `keepOne`, if EVERY tile would be dropped, the first is kept anyway. New tile flag `dungeonCorridorEdge: <edgeId>` (the same `src->dst` id string the transit marker uses) on every tile this builder creates, so tests and tooling can group tiles by corridor.

- [ ] **Step 1: Write the failing guard tests** (append to `tests/dungeon-scene-corridor-edge-tiles.test.mjs`)

```js
import { corridorCellKeyOfTile, skipClaimedCorridorTiles } from '../scripts/dungeon-scene.mjs';

describe('skipClaimedCorridorTiles (#823 cross-edge guard)', () => {
  const t = (gx, gy) => corridorTileAt(gx, gy, 'mid', 0);

  it('keeps tiles on free cells and claims them', () => {
    const claimed = new Set();
    const kept = skipClaimedCorridorTiles([t(1, 1), t(1, 2)], claimed);
    expect(kept).toHaveLength(2);
    expect(claimed).toEqual(new Set(['1,1', '1,2']));
  });

  it('drops a tile whose cell an earlier corridor already claimed (first wins)', () => {
    const claimed = new Set(['1,2']);
    const kept = skipClaimedCorridorTiles([t(1, 1), t(1, 2)], claimed);
    expect(kept.map(corridorCellKeyOfTile)).toEqual(['1,1']);
  });

  it('keepOne keeps the first tile when every tile would be dropped (transit marker safety)', () => {
    const claimed = new Set(['1,1', '1,2']);
    const kept = skipClaimedCorridorTiles([t(1, 1), t(1, 2)], claimed, { keepOne: true });
    expect(kept).toHaveLength(1);
  });

  it('corridorCellKeyOfTile is null for non-corridor art', () => {
    expect(corridorCellKeyOfTile({ texture: { src: 'modules/x/assets/dungeon-rooms/beast-0.webp' }, x: 250, y: 250 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dungeon-scene-corridor-edge-tiles.test.mjs -t "skipClaimedCorridorTiles"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the guard helpers**

```js
const CORRIDOR_TILE_SRC = /\/corridor(?:-[a-z]+)?\.webp$/;

/** "gx,gy" of a corridor tile (centre-anchored: x/y = cell*100 + 50), or null
 * for anything that is not corridor art (room floors, etc.). */
export function corridorCellKeyOfTile(tile) {
  const src = tile.texture?.src ?? tile.texture ?? "";
  if (!CORRIDOR_TILE_SRC.test(String(src))) return null;
  return `${Math.round((tile.x - 50) / 100)},${Math.round((tile.y - 50) / 100)}`;
}

/** #823: drop a corridor tile whose cell an earlier corridor tile already
 * holds (first wins, no merging) and claim the kept cells. `keepOne`: never
 * drop EVERY tile (a transit crossing's marker lives on its tiles). */
export function skipClaimedCorridorTiles(tiles, claimed, { keepOne = false } = {}) {
  const kept = tiles.filter((tile) => {
    const key = corridorCellKeyOfTile(tile);
    if (key === null || !claimed.has(key)) return true;
    return false;
  });
  const result = kept.length || !keepOne || !tiles.length ? kept : [tiles[0]];
  for (const tile of result) {
    const key = corridorCellKeyOfTile(tile);
    if (key !== null) claimed.add(key);
  }
  return result;
}
```

Run: `npx vitest run tests/dungeon-scene-corridor-edge-tiles.test.mjs` — expect PASS.

- [ ] **Step 4: Wire the room-build loop**

In `buildPopulateAndUnlockGraphNode`'s `incomingConnections` loop (verify anchors by content), replace the per-edge `corridorTilesForSegments(...)` + `tiles.push(...)` and the per-crossing `buildTransitCellIfNeeded(scene, cell)` calls with one `corridorEdgeTiles` call per incoming connection:

1. Before the loop: `const claimedCorridorCells = new Set();` and seed it from the scene: for every tile already in `scene.tiles` that `corridorCellKeyOfTile` recognises (this includes stub tiles — count them as occupied, never rewrite them).
2. Per connection, after its `corridorSegments` and `transitCells` are known: `const plan = corridorEdgeTiles({ corridorSegments, transitCells }, { fullWidth: layoutVersion >= 3 });`
3. For each transit crossing `i`, call `buildTransitCellIfNeeded(scene, cell, skipClaimedCorridorTiles(plan.transit[i], claimedCorridorCells, { keepOne: true }), edgeId)`; for the main tiles, `tiles.push(...skipClaimedCorridorTiles(plan.main, claimedCorridorCells))`.
4. #779's `corridorTrapCandidateCells(...)` keeps reading the unfiltered `plan.mainCells` (it used to read `edgeCells` from `corridorTilesForSegments`; the values are identical).
5. `buildTransitCellIfNeeded(scene, cell, tiles, edgeId)` no longer calls `corridorTilesForSegments`; it uses the `tiles` it is given (still returning early when the marker tile already exists, exactly as today) and adds the flags `{ dungeonTransitCellCrossing: marker, dungeonCorridorEdge: edgeId }` to each tile; main tiles get `{ dungeonCorridorEdge: edgeId }` where they are pushed. `edgeId` is the same `src->dst` string already used in the transit marker (`cell.edgeId`); for the main tiles build it from the connection's from/to ids in the identical format. Any other caller of `buildTransitCellIfNeeded` must be updated or must pass freshly computed tiles — grep for every caller.

Run: `npx vitest run tests/dungeon-scene.test.mjs tests/dungeon-scene-trap-placement.test.mjs tests/dungeon-scene-corridor-edge-tiles.test.mjs`
Expected: PASS apart from tests that pin tile counts/digests (re-pinned in Task 5). List which tests fail and why before touching any of them.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-scene.mjs tests/dungeon-scene-corridor-edge-tiles.test.mjs
git commit -m "feat(#823): wire openings-based corridor tiles and the cross-edge guard into the scene builders

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sweep invariants, re-pins, docs, version

**Files:**
- Test (new): `tests/dungeon-corridor-joins-sweep.test.mjs`
- Modify (re-pin, with explanations): `tests/dungeon-router-pipeline.test.mjs` (~30-44 digests), `tests/dungeon-walled-sweep.test.mjs` (~97-99 counts), `tests/dungeon-layout-stubs-geometry.test.mjs` (~50-63, multiset→set comparison), `tests/dungeon-scene.test.mjs` (~339-352 `expectedTileCount` → distinct cells)
- Modify: `docs/architecture.md`, `tools/generate-architecture-graph.mjs` (group `corridor-pieces.mjs`), `module.json`

- [ ] **Step 1: Write the sweep test against the real pipeline**

Reuse the harness `tests/dungeon-router-pipeline.test.mjs` and `tests/dungeon-walled-sweep.test.mjs` use (`tests/helpers/scene-oracle.mjs`: `buildSceneForLayout`, `installFoundryStubs`, `buildSweepScene`; routed layout = `computeRunLayout({topologyRouting:true})` → `planRunLayoutStubs(…,{retreatAvailable:true})` → `buildSceneForLayout(…, 3)`; seeds `sweep-0..99`, `roomCount 6+(i%15)`). For each scene group the corridor tiles by their `dungeonCorridorEdge` flag, map each to its openings with `PIECE_OPENINGS`, and assert:
- **I0:** no cell holds two corridor tiles (ratchet to 0 for routed v3; if a documented rare transit-marker stack remains, assert `<=` its measured count and name the seed).
- **I1 (symmetry):** for every pair of side-adjacent cells of the same corridor, A open toward B iff B open toward A.
- **I2 (no wall across a joint):** for every pair of side-adjacent cells of the same corridor, BOTH are open toward each other. Exclude cells with 3+ same-corridor neighbours (fallback `mid`) and corridors the builder reported `legacy` (wide) — count the exclusions and ratchet them.
- Door ends: a cell with exactly one same-corridor neighbour is an `end` open toward it.
- Include a deliberate before/after proof: write the same invariants against the OLD piece rule (reimplemented in the test from `corridorTileVariant`) on the same layout inputs and assert I2 FAILS for it (so the test is known to detect the live bug).
Measured baselines to compare against (100 routed seeds, origin/main): I1 1,102 failures before / 0 after; I2 2,449 before / 0 after; stacked cells 1,257 before. Runtime about 1s per 10 seeds.

Run: `npx vitest run tests/dungeon-corridor-joins-sweep.test.mjs` — expect PASS; if I0/I1/I2 fail, fix the code (Tasks 3-4), never the invariant.

- [ ] **Step 2: Re-pin the golden tests, explaining each**

Run each affected test, read the failure, and update ONLY with an explanation in a comment: what the digest/count covers, why the piece change legitimately moves it. The v1/v2/v3 scene digests hash tile `x/y/rotation/src`: they MUST change (rotation and src of join/bend cells change, stacked tiles disappear). Split the digest into tiles and walls if it is not already, and show the WALL digests are unchanged (tiles are visual only). Walled-sweep counts (`[15066,5437,7909,2572,…]`): `dupAfter`/`inRoomAfter` must drop to the new measured values; the `<=` ratchets must still hold. `dungeon-layout-stubs-geometry`: change multiset equality to cell-set equality (a duplicate cell is now deliberately removed). `dungeon-scene.test.mjs` `expectedTileCount`: count distinct cells. Do not weaken any assertion that is not about tile identity.

- [ ] **Step 3: Architecture docs**

Run the `update-architecture-docs` skill (`.claude/skills/update-architecture-docs/SKILL.md`): regenerate the graph, place `scripts/corridor-pieces.mjs` in the best-fitting `GROUPS` entry, add one subsystem-prose sentence, re-check the circular-imports section.

- [ ] **Step 4: Version bump (minor), full suite, commit**

Bump `module.json` per Global Constraints. Run `npm test` (known wall-clock flake `tests/dungeon-reseed-sweep.test.mjs`, issue #787: if it is the only failure, re-run it alone).

```bash
git add -A tests docs tools module.json
git commit -m "feat(#823): corridor joins/corner/dedup sweep, re-pinned goldens, docs, version

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Live verification (controller + owner, after the world updates)**

Start a new dungeon run (the fix changes tile generation, so existing scenes keep their old tiles). With the relay, scan the scene's corridor tiles: group by `dungeonCorridorEdge` and check I0/I2 on the live scene (no stacked cells; every consecutive pair open toward each other). The owner then looks at: the corridor from the depth-1 combat room to the depth-2 combat room (the sealed-looking pair is now straight pieces), the corridors out of "The Perfect Hand" (corners at the turns), a door end (still a cap with the door in it), and confirms no thin white border at joints.

- [ ] **Step 6: File the follow-ups**

Create two issues: (1) overshoot corridor cells that land inside the destination room (370 per 100 seeds); (2) hidden west-face detour entries whose last leg runs down the destination room's own first column or through another room (27/12/17 cases per 100 seeds). Reference #823.

---

## Self-Review

**1. Spec coverage:** The approved design maps to tasks: corner art with an owner gate (Task 1); pieces chosen from openings with end caps only at true ends and straight `mid` at continuing joins (Tasks 2-3); one corner tile at a bend replacing the two stacked caps (Task 3 L-shape test); scene-wide one-tile-per-cell guard including the transit site with marker safety (Tasks 3-4); a routed-pipeline sweep that fails on the old rule and passes on the new (Task 5); re-pins explained; live check on the named corridors (Task 5). The two measured-but-out-of-scope defects are filed as follow-ups.

**2. Placeholder scan:** The art script is explicitly a baseline to iterate against four written acceptance criteria and an owner approval gate (the one inherently visual task); all code tasks contain complete code.

**3. Type consistency:** `corridorPieceForOpenings`/`openingsOf`/`cellKey`/`hasBlock2x2`/`PIECE_OPENINGS` (Task 2) are used by `corridorEdgeTiles` (Task 3); `corridorEdgeTiles`'s `{main, transit, mainCells, legacy}` is consumed by Task 4's wiring; `corridorTileAt` is extracted in Task 3 and used by it; `skipClaimedCorridorTiles`/`corridorCellKeyOfTile` (Task 4) share the `"gx,gy"` key format with `cellKey`; the `dungeonCorridorEdge` flag is written in Task 4 and read by Task 5's sweep.

**4. Review Focus:** the I2 "no wall across a joint" check (with the before/after proof), no stacked tiles, door ends and one-cell corridors, transit marker survival, #779 unaffected, wide/3+-opening cells not crashing, and explained re-pins each have an owning test or step.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-corridor-joins-and-corner.md`.
