# Transit-cell corridor geometry — chained crossing points — design

**Tracks:** [#225](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/225)

## Problem

A multi-cell corridor's own geometry (`scripts/dungeon-layout.mjs`'s
`buildEdgeCorridor` multi-cell branch, `transitCellCrossing`, and
`scripts/dungeon-scene.mjs`'s `buildTransitCellIfNeeded`) is built from
pieces that are each independently positioned — a room's real door, a
transit cell's own entry/exit offsets (seeded via `doorOffsetAt`,
keyed only by that cell's own rank/col/side/edgeId) — with nothing
ensuring two pieces that share a physical boundary actually agree on
where they cross it. Confirmed via direct reproduction against the
real, shipped code (not just the earlier review's own account):

- A transit cell's own containment wall gets its gap at its own
  independently-seeded exit offset (e.g. `x=[311,312]`), while the
  corridor's actual connector path bends to reach the target's real
  door at a completely different position (e.g. `x=[303,304]`) — two
  unrelated positions on the same shared border, so the wall solidly
  blocks the corridor everywhere except its own irrelevant gap.
- The same class of mismatch exists on the **source** side too (the
  first transit cell's own independently-seeded entry offset vs. the
  source room's real exit point) — not previously measured, but
  confirmed by the same reproduction technique, and structurally
  identical to the target-side defect.
- Two transit cells that share a border (a multi-cell corridor
  crossing 2+ intermediate cells) each seed their own crossing point
  on that shared border independently, so they essentially never
  coincide — same root cause, one border further out.
- `buildTransitCellIfNeeded`'s own idempotency marker
  (`${rank},${col}:${entrySide}-${exitSide}`) omits the edge's own id,
  so a second edge crossing the same cell with the same entry/exit
  side pair (routine whenever multiple sources converge on one gate
  face from the same general direction) is silently treated as
  "already built" and never gets its own tiles or opening.

No test anywhere in this repo's corridor-routing effort has ever
checked "does a wall end up covering another wall's own door opening"
— every existing sweep only checks path existence (`findCorridorPath`
non-null) or footprint overlap (a corridor segment vs. a room's rect),
neither of which catches any of the above.

## Goals

- A multi-cell corridor's geometry is genuinely buildable: no wall
  ever covers a door or opening it isn't supposed to, on either end or
  at any intermediate cell boundary.
- Fix this with one coherent mechanism, since all four symptoms above
  share the same root cause (independently-computed crossing points
  instead of derived ones) — not four separate patches.
- Add real regression coverage checking actual buildability (wall vs.
  door/opening geometry), not just the proxies (`findCorridorPath`
  non-null, footprint overlap) every existing sweep in this effort has
  relied on.

## Non-goals

- Re-attempting the #174 merge-room multi-parent gate-sharing fix
  (the `incomingFaceFor` change that was reverted as net-negative) —
  a separate, later decision once this ships, not part of this issue.
- Any change to `findCorridorPath`'s own pathfinding logic, `computeRanks`/
  `computeColumns`, or the incoming-face redesign's own mechanism —
  this issue is scoped to the geometry *built* from an already-found
  path, not how that path is found.
- Visual/cosmetic polish beyond correctness — a minor redundant tile
  where a forced point exactly coincides with an anchor (see Error
  handling) is accepted, not special-cased away.

## Decision

Stop seeding each transit cell's own entry/exit points independently.
Instead, chain them: the first transit cell's entry point is *forced*
to align with the source room's real exit point, the last transit
cell's exit point is *forced* to align with the target room's real
entry point, and every intermediate cell's exit point becomes the
*next* cell's forced entry point by construction — never independently
reseeded. The only place genuine randomness remains is a corner cell's
own free axis (the coordinate perpendicular to its forced entry has no
anchor), which stays seeded via the existing `doorOffsetAt` convention
for visual variety.

**Why this closes all four symptoms with one change:** each symptom is
the same defect (two independently-computed positions that are
supposed to be the same point, but aren't) recurring at a different
boundary — source-to-first-cell, cell-to-cell, last-cell-to-target.
Anchoring the chain's two ends to the real, already-known door
positions and propagating every interior point from its own neighbor
makes "do two adjacent pieces agree on their shared crossing point"
true by construction, not by coincidence.

**Why not a post-hoc alignment/snap pass** (considered and rejected):
after computing everything independently as today, detect mismatched
shared borders and force one side to match the other. Rejected: doesn't
cleanly define which side "wins," and doesn't anchor the two true
endpoints (the real room doors) to anything either — it would still be
possible for the whole chain to land somewhere that doesn't reach the
actual doors, just internally consistent with itself.

**Why not rewriting the multi-cell branch to draw one continuous
polyline** (considered and rejected): architecturally the "purest"
fix, but a much larger rewrite of `buildEdgeCorridor`/`transitCellCrossing`'s
existing responsibility split for the same correctness guarantee the
chaining approach achieves with a small, incremental change to
existing functions.

## Architecture

### `projectOntoSide` (new, pure, `scripts/dungeon-layout.mjs`)

Given a known absolute point (an anchor — a room's real door, or a
transit cell's own already-computed crossing point) and a target
cell/side, constructs the corresponding point on *that* cell's own
boundary, sharing the anchor's axis-coordinate:

```js
function projectOntoSide(cell, side, anchor) {
  if (side === 'north') return { x: anchor.x, y: cell.gy };
  if (side === 'south') return { x: anchor.x, y: cell.gy + cell.gh };
  if (side === 'west') return { x: cell.gx, y: anchor.y };
  return { x: cell.gx + cell.gw, y: anchor.y }; // east
}
```

### `transitCellCrossing` — gains optional forced points

New 7th parameter, an options object, used in place of the seeded
computation whenever supplied:

```js
export function transitCellCrossing(seed, rank, col, entrySide, exitSide, edgeId, { forcedEntryPoint, forcedExitPoint } = {}) {
  const cell = cellBounds(rank, col);
  const entryPoint = forcedEntryPoint
    ?? SIDE_POINT[entrySide](cell, doorOffsetAt(seed, `transit-${rank}-${col}-${entrySide}-${edgeId}`, 'incoming', cell[SIDE_SPAN[entrySide]]));
  const exitPoint = forcedExitPoint
    ?? SIDE_POINT[exitSide](cell, doorOffsetAt(seed, `transit-${rank}-${col}-${exitSide}-${edgeId}`, 'outgoing', cell[SIDE_SPAN[exitSide]]));
  // Everything after this line (straight-vs-corner corridorSegments
  // logic) is completely unchanged — it already only ever consumes
  // entryPoint/exitPoint generically, regardless of where they came
  // from.
  ...
}
```

Any caller that doesn't pass the new options object gets the exact
existing seeded behavior (the default `{}` falls through both `??`
branches) — provably a no-op everywhere except `buildEdgeCorridor`'s
own multi-cell branch, the only caller that will pass forced points.

### `buildEdgeCorridor`'s multi-cell branch — the chain

`exitPoint`/`entryPoint` (the source's and target's real door
positions — the existing formulas, unchanged) move earlier in the
function, before the transit-cell loop, so they're available as the
chain's own anchors:

```js
let chainAnchor = exitPoint;
for (let i = 1; i < path.length - 1; i += 1) {
  const cell = path[i];
  const cb = cellBounds(cell.rank, cell.col);
  const entrySide = directionBetween(cell, path[i - 1]);
  const exitSide = directionBetween(cell, path[i + 1]);
  const isLast = i === path.length - 2;
  const forcedEntryPoint = projectOntoSide(cb, entrySide, chainAnchor);
  const forcedExitPoint = isLast ? projectOntoSide(cb, exitSide, entryPoint) : undefined;
  const crossing = transitCellCrossing(seed, cell.rank, cell.col, entrySide, exitSide, edgeId, { forcedEntryPoint, forcedExitPoint });
  transitCells.push({ rank: cell.rank, col: cell.col, entrySide, exitSide, edgeId, ...crossing });
  chainAnchor = crossing.exitPoint;
}
```

`cornerConnector` (connects a room's real door to the first/last
transit cell) needs **no changes** — once fed correctly-aligned
points, its existing geometry naturally produces the right shape (see
Error handling for why a shared-axis case degenerates cleanly).

### `buildTransitCellIfNeeded` — idempotency marker gains the edge id

`scripts/dungeon-scene.mjs`, one-line change:

```js
const marker = `${cell.rank},${cell.col}:${cell.entrySide}-${cell.exitSide}:${cell.edgeId}`;
```

(`edgeId` is already on each `transitCells` entry per the loop above.)
Two different edges crossing the same cell with the same side pair now
each get their own tiles and their own opening.

## Data flow

Unchanged from today's existing pipeline (`findCorridorPath` →
`buildEdgeCorridor` → per-cell `transitCellCrossing` →
`buildTransitCellIfNeeded`) — this design changes what values flow
between these steps (forced vs. independently seeded points), not the
steps themselves or their call order relative to the rest of the
system.

## Error handling / edge cases

- **A single-intermediate-cell path** (path length exactly 3): the
  loop's only iteration has `isLast === true`, so both
  `forcedEntryPoint` and `forcedExitPoint` are set from the two real
  anchors — no seeded value at all for this case.
- **A forced point that exactly coincides with its anchor's own
  axis** (e.g. source exits south, first transit cell's own entry is
  forced to the same x): `cornerConnector`'s own `corner = {x: to.x, y:
  from.y}` becomes equal to `from` itself, so its first leg degenerates
  to a minimal `CORRIDOR_LEN`-sized box sitting on the anchor's own
  point, and the second leg carries the full traversal. This is a
  harmless, minor cosmetic redundancy (an extra stacked floor tile at
  the door), not a correctness defect — not special-cased away, per
  this design's own Non-goals.
- **Determinism**: the one remaining seeded value (a corner cell's own
  free-axis offset) still goes through `doorOffsetAt` with the same
  seed/key convention as today — same seed, same output.
- **The #110 fog-leak-avoidance ordering** is unaffected — this design
  changes coordinates, not the create-before-delete sequencing
  `buildTransitCellIfNeeded` already follows.

## Testing

- Unit tests for `projectOntoSide` (pure, all four sides).
- `transitCellCrossing` with forced points: confirm forced values are
  used verbatim (not reseeded) for both entry and exit independently,
  and confirm omitting the options object still produces byte-identical
  output to today's existing tests (regression guard for the majority
  of this function's other callers/tests).
- `buildEdgeCorridor` multi-cell branch: for a straight multi-cell
  corridor (no obstacle, 2+ intermediate cells, same column) and a
  bent one (obstacle-routed, mixing north/south and east/west legs),
  assert the actual wall/tile output — not just the corridor segments
  — has no wall covering the source's or target's own door gap, and
  that every consecutive pair of transit cells' shared-border gaps
  overlap.
- `buildTransitCellIfNeeded`'s marker: two different edges crossing the
  same cell with the same entry/exit side pair both get their own
  tiles built (previously, the second was silently skipped).
- **The whole-pipeline buildability sweep** (the test class this issue
  itself found completely missing): across a large seed/room-count
  sweep using the real generation pipeline, for every multi-cell
  connection, actually construct the wall/tile geometry
  (`buildEdgeCorridor` + `transitCellContainmentWalls`, the same pure
  functions the live pipeline calls) and assert zero instances of "a
  wall's solid segment covers a door/opening it isn't supposed to" —
  this is the buildability property, not a proxy for it.

## Out of scope, tracked separately

- The #174 merge-room multi-parent gate-sharing problem itself —
  revisiting the reverted `incomingFaceFor` fix is a separate decision
  once this ships (this design's own Non-goals).
