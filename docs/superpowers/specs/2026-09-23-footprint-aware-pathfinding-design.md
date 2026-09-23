# Footprint-aware pathfinding — design

**Tracks:** [#140](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/140)

## Problem

Combat AI movement (`stepToward`, `scripts/dungeon-combat.mjs`) stalled
permanently, live: a Large (2×2) creature (Zombie Brute) ended up sitting
on the single grid square connecting two rooms, and every other
combatant — both allies trying to path past it and opponents trying to
path through it — silently re-chose the identical "Move toward X" action
every turn, across 2+ full rounds, with zero net position change.

## Investigation

- **Confirmed root cause, party side:** `movementBlockedEdges` builds
  `findPath`'s `isBlocked(a,b)` edge predicate from wall data plus
  `hostileFootprints` (opponent-only occupancy). Zombie Brute is hostile to
  the party, so it correctly blocks the party's `findPath` edges through
  the connector — `findPath` is working correctly on the geometry it's
  given.
- **Corrected root cause, ally side** (the original issue report attributed
  this to the same hostile-edge-blocking mechanism; verified against the
  actual code and posted as a correction to the issue): Zombie Brute and
  Plague Zombie share hostile disposition — they're allies to each other,
  and `movementBlockedEdges` only ever consults `hostileFootprints`
  (`combatantOpponents`), never allies. An ally's occupied cell **never**
  blocks a `findPath` edge. The actual mechanism is `walkPath`
  (`dungeon-combat.mjs:2025-2050`): a path may pass *through* any
  occupied cell (ally or hostile), but may never *land* there
  (`otherCombatantFootprints`, ally+hostile). If the chokepoint cell is the
  only valid landing spot within speed + melee reach, `walkPath` returns
  `null` — same zero-movement symptom, different code path.
- **Deeper cause, confirmed:** nothing anywhere validates a mover's own
  final resting cell has room for its own multi-square footprint.
  `tokenCell`/`stepToward`'s `start`/`goal` are single reference cells
  (top-left corner only, per `placement.mjs`'s `footprint` convention);
  `findPath` (`scripts/pathfinding.mjs:83-147`) is a standard single-cell
  8-directional A* with zero footprint concept — `isBlocked(a,b)` is its
  only reachability signal, called on bare `{gx,gy}` pairs. This is almost
  certainly how a 2×2 creature ended up straddling a wall/corridor boundary
  it doesn't actually fit through: its own movement was never validated
  against its own size, only ever against a single point.
- **Existing precedent to reuse, not invent:** `placement.mjs`'s
  `freeSpot`/`freeSpotInRect` (lines 46-85) already do full footprint-fit
  validation — ring-search outward, testing a candidate `{gx,gy,gw,gh}`
  spot via `overlaps()` against everything occupied — used today for
  encounter/hazard spawn placement, never for movement.
- **Blast radius:** `findPath` has 4 call sites, all assuming a 1×1 mover:
  `dungeon-combat.mjs`'s `stepToward` (direct) and `posturePath`
  (retreat/reposition), and `dungeon-follow-mechanics.mjs:93`
  (follow-the-leader, #87's territory — explicitly mirrors
  `dungeon-combat.mjs`'s wall/occupancy pattern per its own docblock).

## Decision

Two pieces, confirmed with Cory: **(a)** make `findPath`/`walkPath`
genuinely footprint-aware — the general, correct fix, closing this bug
class for any creature size rather than just this one reported shape —
and **(c)** give a genuine "route exists but is occupied" stall an
explicit signal distinct from "no route exists at all," since even with
correct footprint validation two same-size creatures can still
temporarily contest one narrow gap.

Rejected: a scoped check limited to just the one-square-connector case
(cheaper, but doesn't generalize — the next differently-shaped version of
this bug, e.g. a 2-wide chokepoint with a 2×2 occupant, would need its own
separate patch).

## Architecture

### (a) Footprint-aware `findPath`

`findPath(start, goal, isBlocked, bounds, maxExpansions, footprint = {gw:1, gh:1})`
gains an optional 6th parameter, `footprint` — defaulting to `{gw:1,gh:1}`,
preserving today's exact behavior for every call site that doesn't pass
one. `start`/`goal` remain the mover's own top-left reference cell (no
change to caller-facing coordinate meaning), matching `placement.mjs`'s
existing top-left-corner convention.

Per-step validation for a candidate move from `current` to `neighbor`
(delta `{dx,dy}`) decomposes into the mover's own `gw×gh` cells, reusing
`isBlocked`'s existing single-cell-pair signature rather than inventing
swept-polygon geometry:

```js
function footprintBlocked(current, neighbor, dx, dy, isBlocked, footprint) {
  for (let fx = 0; fx < footprint.gw; fx += 1) {
    for (let fy = 0; fy < footprint.gh; fy += 1) {
      const a = { gx: current.gx + fx, gy: current.gy + fy };
      const b = { gx: a.gx + dx, gy: a.gy + dy };
      if (isBlocked(a, b)) return true;
    }
  }
  return false;
}
```

Called in place of the existing single `isBlocked(current, neighbor)`
call (and the diagonal corner-cutting flank checks, which get the same
per-cell-of-footprint treatment) — a 1×1 footprint reduces to exactly
today's single call, so this is provably a no-op for every existing
caller that doesn't opt in.

**Occupancy** (currently bundled inside each caller's own `isBlocked`
closure via `cellOccupied(b, footprints)`, hardcoded to `{gw:1,gh:1}` for
the *candidate* cell) needs its own footprint-aware treatment separate
from the wall predicate — `cellOccupied` already takes a footprints list
and already uses real `gw`/`gh` for the *blockers*; it just never receives
real `gw`/`gh` for the cell being tested. `movementBlockedEdges`
(`dungeon-combat.mjs:1891`) and `dungeon-follow-mechanics.mjs`'s
equivalent both need to build their occupancy check against the mover's
own real footprint size instead of a hardcoded 1×1, threading the same
`footprint` value through to wherever they call `cellOccupied`.

`walkPath`'s landing-cell check (`cellOccupied(path[i], occupantFootprints)`,
line 2045) gets the identical treatment — check the mover's real `gw×gh`
footprint at each candidate landing cell, not a hardcoded single cell.

**Callers thread their own token's real footprint through**: `stepToward`
and `posturePath` compute `footprint(combatant.token, gridSize)` (already
exported from `placement.mjs`, already used elsewhere in this same file)
and pass its `{gw,gh}` to `findPath`/`walkPath`.
`dungeon-follow-mechanics.mjs`'s `findFollowMove` does the same for its
own mover.

**Destination self-fit — correction (found during Task 1's review, not
anticipated when this section was first written):** the claim originally
here — that `footprintBlocked`'s transition checks alone catch a
footprint straddling a wall — is wrong, and was disproven empirically
during Task 1's task review. `footprintBlocked` only checks edges
*crossed* by a candidate move (source-cell-to-destination-cell pairs); it
never checks edges *internal* to a single candidate position (adjacency
between two of that position's own footprint cells). A 2×2 mover can
therefore end up with its footprint straddling an internal wall it never
"crossed" — e.g. sliding sideways along a corridor whose footprint already
spans both sides of a perpendicular wall from the very first candidate
cell, since a purely horizontal move never triggers a check on that
wall's (vertical) edges at all.

The fix, implemented in Task 1: a second, independent helper —
`footprintValid(position, isBlocked, footprint)` — that rejects a
candidate position outright whenever *any* single edge between two of its
own footprint's own adjacent cells is blocked (a "fully open interior"
requirement, not merely "connected via some interior path" — a solid
creature's own body cannot have a wall segment running through any part
of it, so even one blocked internal edge is disqualifying regardless of
whether the rest of the interior would still be topologically connected
around it). Applied to every candidate `neighbor` in the search, and to
`start` itself (including the `start === goal` short-circuit) — a mover
already sitting in a position its own footprint doesn't fit is refused a
"path" of length 1 the same way any other invalid position is refused.
1×1 footprints are unaffected (no internal cell pairs exist to check, so
the helper is an unconditional no-op).

### (c) Explicit stuck signal

`stepToward` (and `posturePath`'s retreat/reposition paths) currently
return nothing distinguishable when `walkPath` returns `null` for "every
candidate landing cell within reach is occupied" versus `findPath`
returning `null` for "no route exists at all" (e.g. fully walled off).
Both collapse to the same silent no-op today. Add a return value (or a
new exported query function, decided at implementation time based on
which reads more naturally against this file's existing conventions)
distinguishing:

- `no-route` — `findPath` itself returned `null` (genuinely no path,
  walled off).
- `blocked` — `findPath` found a route but `walkPath` had no valid
  landing cell (every reachable waypoint within range is occupied).
- normal move / already-adjacent (unchanged from today).

This is purely a visibility/diagnosability improvement — no retry logic,
no priority/bump mechanism, no change to *whether* a stuck combatant
moves this turn (still doesn't, correctly, since there's genuinely nowhere
valid to go). The AI turn loop's own chat announcement (`"... chose: Move
toward X"`) should reflect which of the two happened, so a genuine
temporary contest over a narrow gap reads differently in the log than a
combatant that's actually permanently unreachable.

## Testing

- `pathfinding.mjs`: new unit tests for `findPath` with a non-default
  `footprint` — a 2×2 mover correctly refused a route only a 1×1 mover
  could take (a one-square-wide corridor), and correctly still finds a
  route through a corridor wide enough for its real size. Confirm the
  1×1-default case is byte-identical to today's existing test suite
  (regression, not just new coverage).
- `dungeon-combat.mjs`/`dungeon-follow-mechanics.mjs`: reproduce this
  issue's exact live scenario as a fixture — a Large ally-of-the-mover
  occupying the sole connector cell — and confirm `walkPath` correctly
  returns `null` (not a bad landing cell) for both the ally-contesting and
  hostile-blocking cases, and that the new stuck-vs-no-route distinction
  reports correctly for each.
- Confirm via a hand-trace (and live verification if the relay is
  reachable) that a real Zombie-Brute-sized creature's own movement
  planning now refuses to end up straddling a wall it doesn't fit
  through — this was never previously tested at all.

## Out of scope

- #141's separate, still-unconfirmed hypothesis about an external writer
  (possibly PF2e's own Shove/forced-movement automation) producing
  non-grid-aligned positions outside this module's own code paths — a
  different mechanism, tracked separately, needing its own live
  `updateToken` hook diagnosis.
- Retry/priority/bump logic for a genuine mutual chokepoint contest (e.g.
  two creatures each wanting to cross a gap the other occupies) — (c)
  only makes the stall visible/distinguishable, doesn't resolve it
  mechanically. Worth its own follow-up if it turns out to matter in
  practice.
- Any change to `pathfinding.mjs`'s underlying A* algorithm structure
  beyond the per-footprint-cell decomposition described above (no
  alternate search algorithm, no caching/memoization of footprint
  results) — the existing `maxExpansions` cap and per-step cost increase
  (O(gw×gh) instead of O(1) per candidate step) are accepted as the real,
  bounded cost of correctness here, not optimized further.
