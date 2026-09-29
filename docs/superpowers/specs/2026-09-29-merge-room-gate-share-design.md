# Merge-Room Second-Parent Corridor Overlap — Design

**Issue:** [#297](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/297) — merge room's second real parent can route a
corridor straight through a sibling room's own footprint.

**Status:** Approved for planning (2026-09-29).

## Problem

`scripts/dungeon-layout.mjs`'s `findCorridorPath` performs a BFS between a
room's own graph position and a connecting room's own graph position,
treating any occupied cell that isn't the edge's own `fromRoomId`/`toRoomId`
as blocked. In this generator's fully-pregenerated, densely-packed layout,
when a merge room's second real parent needs to reach it through an
intermediate rank/column occupied by an unrelated sibling room, there is
usually no free cell to route around — the BFS honestly returns `null`.

`buildEdgeCorridor`'s same-column (`south`-exit) and same-rank (`east`-exit)
fast paths both fall back, on a null path, to a direct straight line from
the source's door to the target's door. That fallback is a long-standing,
deliberately-kept limitation (see `buildEdgeCorridor`'s own comment above
the fast-path branches) — but when the straight line's fixed cross-axis
coordinate happens to fall inside an intermediate blocking room's own
footprint, the result is a real, walkable corridor — with real doors at
both ends — cutting through that room's floor and contents.

**Confirmed live** (seed `1790705053246-4vdgop9m7i5`, scene `DXOBU18fDPJstklG`):
edge `room-room-entry-0` (rank 1) → `room-room-room-entry-0-0` (rank 3, a
merge room reached via a detour) passes through rank 2, occupied by
`room-room-room-entry-0-1` (an unrelated sibling from this edge's own
perspective). The resulting corridor bisects that sibling's 6×6 rect, with
no `dungeonTransitCellCrossing` flag on its floor tiles — confirming it is
the same-column fast path's null-path fallback, not a multi-cell route, and
not a regression from #288/#294 (#294 deliberately does not extend
containment into this exact scenario; see #297's own issue body for the
full non-regression trace).

## Prior attempts (why this needs care)

Both filed under #174, both reverted — full history captured in #297's own
issue body and in `findCorridorPath`'s/`incomingFaceFor`'s own docblocks:

1. **Exempt a target's `legitimateSourceIds` from `isBlocked`.** Unsound:
   let a path route straight through a co-parent's own real room as if it
   were empty transit space, which then got walled like a transit cell,
   potentially sealing the co-parent's own door.
2. **Narrow `incomingFaceFor` to require sole-source legitimacy.**
   Architecturally sound in isolation, but net-negative when tried: it
   converted ~1083 previously-direct connections into detours, ~89% of
   which broke due to multi-cell/transit-cell geometry bugs that existed
   at the time. Those bugs (crossing-point misalignment, dropped shared
   crossings, unaligned door offsets) are exactly what #225/#230/#288/#294
   have since fixed — but this design does not re-attempt approach 2, for
   the reason below.

## Chosen approach: margin-aware dogleg through the blocking room's own cell

Neither prior attempt used a structural fact this session confirmed by
re-reading `cellMarginWalls`'s own current docblock: **a room always
anchors at its own cell's NW corner** (`roomRect`'s invariant) — margin
only ever exists on a room's **east** and **south** sides, and that margin
is always at least `CORRIDOR_LEN` (1 unit) wide, even for a LARGE room
(`ROW_STRIDE - ROOM_SIZE_LARGE = 1`). That margin band is real,
already-modeled passable space immediately next to every occupied room —
not room interior, and not contingent on finding some other free cell
elsewhere in a dense layout.

Instead of trying to route *around* a blocking room (approach 2, which
depends on a free cell existing elsewhere — often it doesn't) or ignoring
the blockage entirely (approach 1), this design routes *through* the
blocking room's own cell but confines the corridor to its margin band,
never crossing into the room's actual footprint. The corridor becomes
correct by construction: it is geometrically impossible for it to overlap
the blocking room's rect, the same way `transitCellCrossing` already
guarantees this for genuinely empty cells.

### Scope

This design covers exactly the reported failure mode:

- The `exitFace === 'south' && sameColumn` and `exitFace === 'east' &&
  sameRank` fast-path branches of `buildEdgeCorridor`, in their null-path
  (`!path`) case only.
- Exactly **one** intermediate blocking cell between `fromPos` and `toPos`
  — concretely, `toPos.rank === fromPos.rank + 2` (south path) or
  `toPos.col === fromPos.col + 2` (east path). A larger rank/column gap
  always has more than one intermediate cell and falls to the residual
  below, unconditionally — this design never inspects more than the single
  cell immediately after the source's own cell.

**Explicitly out of scope, left as documented residuals** (same pattern as
#231/#232):

- The generic corner-fallback branch (different column *and* row) — it can
  in principle also cross an occupied cell on a null path, but was not
  part of the reported repro and has different geometry (single corner,
  not a long straight run) that needs its own investigation.
- Two or more consecutive blocking cells in the same column/row. The
  detection logic (below) only evaluates the single blocking cell; a
  second one is left to the pre-existing direct-line behavior, same as
  today.

### Detection

When `path` is `null` and `fromPos`/`toPos` are 2+ ranks (south path) or
columns (east path) apart in the same column/row, the intermediate cell(s)
are directly computable (no search needed — they're every rank/column
strictly between the two positions, same column/row). For the single
intermediate cell this design handles:

1. Look up its occupant in `occupiedCells`.
2. If occupied, get that room's rect (`occupantRect`). Because it anchors
   at the cell's own `gx`/`gy`, its footprint spans exactly
   `[cell.gx, cell.gx + occupantRect.gw]` (south path) or
   `[cell.gy, cell.gy + occupantRect.gh]` (east path).
3. If the fixed cross-axis coordinate (`doorX0` for the south path,
   `doorY0` for the east path) falls inside that span, a dogleg is needed
   for this cell. If it already falls in the room's own margin (at or past
   the far edge), the existing straight-line geometry already misses the
   room — no dogleg, no behavior change.

### Dogleg geometry

When a dogleg is needed, the corridor's cross-axis coordinate shifts to
just past the blocking room's far edge — `occupantRect.gx + occupantRect.gw`
for the south path (its east margin), `occupantRect.gy + occupantRect.gh`
for the east path (its south margin) — for the span of that one blocking
cell (its own `gy`..`gy+gh` or `gx`..`gx+gw`), then shifts back to the
original `doorX0`/`doorY0` at the cell's boundary before continuing toward
the target. Two corner turns, using the same corner-shape construction
`transitCellCrossing` already uses for its adjacent-side case — this design
reuses that shape, it does not invent new turn geometry.

### Wall changes

Two pieces of new containment, each scoped precisely to its own job (the
explicit lesson from #294's first-draft regression — new containment must
bound itself to exactly the reported problem, not to a nearby-looking
coordinate):

1. **Side walls containing the dogleg lane itself**, within the blocking
   cell only, at the dogleg's own real floor edges — same "seal everything
   except the declared opening" approach `transitCellContainmentWalls` and
   the #294 fast-path fix already use.
2. **A second opening in the blocking room's own `cellMarginWalls` call.**
   Today `cellMarginWalls(rect, rank, col, { openSide, openOffset,
   openWidth })` accepts exactly one opening per call, matching that
   room's own single outgoing connection. A foreign pass-through corridor
   needs a *second*, independent opening on whichever side the dogleg
   uses — which may be the same side as the room's own outgoing gap (e.g.
   both on the east side) or a different one. `cellMarginWalls` must
   generalize from a single `{openSide, openOffset, openWidth}` to a list
   of openings per side, sealing whatever remains between them (a room can
   have at most one *own* outgoing opening per side today, plus at most one
   *foreign* pass-through opening per side under this design's own scope —
   never more than two on the same side).

   The pass-through opening's `offset`/`width` must be **the same value**
   the dogleg construction (above) actually used for its lane — passed
   explicitly, not independently re-derived — per this file's own
   recurring "two things must agree on a shared boundary" lesson
   (#225/#230/#288, all four confirmed instances tracked in this session's
   memory). The implementation plan must make this an explicit, named
   value threaded from `buildEdgeCorridor`'s dogleg output through to
   `dungeon-scene.mjs`'s call into the blocking room's own
   `cellMarginWalls`, the same way `outgoingMarginOffset` already threads a
   room's own corridor span into its own margin-wall call today.

### Build-order handling (added after spec approval — see below)

Rooms in this module are built lazily, on demand, as the party reaches
them (`buildPopulateAndUnlockGraphNode`'s `alreadyBuilt` check in
`dungeon-scene.mjs`) — not in a single upfront pass. A room's own incoming
edges (including a dogleg-needing edge) are built when *that room* is
built, using whichever other rooms already exist in `occupiedCells` at
that moment. The blocking room can therefore be built **either before or
after** the merge room whose second-parent edge doglegs through it — and
the live-reported repro is specifically the harder order: the blocking
room (`room-room-room-entry-0-1`) had already been visited and built
before the party reached the merge room via its detour path, which is
when the dogleg-needing edge actually gets processed.

This was not captured in the design's first pass and materially changes
scope. Two orderings, both required:

1. **Blocking room not yet built.** A pending-openings registry, keyed by
   blocking room id, persisted the same way other per-run layout state is
   persisted (`game.settings.get('pf2e-dungeon-crawl', 'dungeonRuns')`).
   `buildRoomAtGraphNode` consults it for its own room id when building its
   own margin walls, the same way it already consults `outgoingMarginOffset`
   for its own outgoing connection's opening.
2. **Blocking room already built.** Retroactively patch the room's already-
   placed margin wall in the live scene: locate its existing
   `dungeonCellMarginWallForRoom`-flagged wall(s) on the relevant side,
   delete them, and recreate them with the added opening (its own existing
   opening, if any, preserved via the same generalized `cellMarginWalls`
   call from case 1 — recomputed, not hand-merged).

Both cases must produce the exact same wall geometry a fresh build would
have produced had the two rooms been built in the other order — i.e. this
is not two different code paths with two different notions of "correct,"
it's one geometry computation (the generalized `cellMarginWalls` call)
invoked from two different triggers (a room's own build step, or a
foreign edge's build step reaching back to patch an already-built room).

### Non-goals

- This design does not touch `findCorridorPath`'s BFS, `incomingFaceFor`,
  or the general multi-cell transit-cell chain (`path.length > 2`) at all.
  Those are unaffected; this is purely a change to the null-path fallback
  geometry and the blocking room's own margin-wall construction.
- This design does not attempt to re-measure or re-enable the previously-
  reverted sole-source `incomingFaceFor` narrowing (prior attempt 2). The
  margin-dogleg approach fixes the reported overlap directly, by
  construction, without depending on an empirical re-measurement of a
  much larger, riskier structural change.

## Testing

- A dedicated regression test reproducing this seed's exact scenario
  (mirroring the `sweep-12` regression test pattern established for
  #294): a merge room's second parent, same column, an intermediate
  sibling room whose footprint the naive direct line would cross.
- A sweep assembled the same way as the #294 sweep, asserting the real
  downstream property, not a proxy: **no corridor segment overlaps any
  room's own footprint rect**, system-wide, across the standard seed
  corpus — not "path was non-null" and not "door count improved" (this
  file's own thrice-confirmed lesson: a proxy metric improving does not
  imply the real geometry is buildable).
- Confirm the blocking room's own doors (both its incoming door and any
  outgoing connection of its own) stay uncovered by the new pass-through
  opening — i.e. the two openings on a shared side, when both present,
  don't collide or clamp into each other.
- Live Foundry verification against the exact reported seed once merged,
  per this session's established practice.

## Success criteria

- The reported live scenario (seed `1790705053246-4vdgop9m7i5`, edge
  `room-room-entry-0` → `room-room-room-entry-0-0`) no longer produces a
  corridor overlapping `room-room-room-entry-0-1`'s footprint.
- System-wide sweep: zero corridor/room-footprint overlaps for the
  single-intermediate-blocking-cell case, across the standard seed corpus.
- No regression in existing #225/#230/#288/#294 coverage (full test suite
  green, plus the existing sweeps' own assertions unchanged in outcome).
- Any remaining overlap case (two-or-more consecutive blockers, or the
  generic corner-fallback branch) is measured and documented as an
  explicit residual, not silently left uncovered.
