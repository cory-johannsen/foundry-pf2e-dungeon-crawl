# Merge-Room Second-Parent Corridor Overlap — Design

**Issue:** [#297](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/297) — merge room's second real parent can route a
corridor straight through a sibling room's own footprint.

**Status:** Round 1 (margin-aware dogleg) implemented, individually
reviewed clean, but rejected at final whole-branch review (2026-09-29) —
see "Round 2" below for the amendment now approved for planning.

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

### Build-order handling (corrected after spec approval — see below)

An earlier revision of this section assumed rooms are built lazily as the
party progresses, and specified a pending-openings registry plus
retroactive Foundry wall-patching to handle "the blocking room was already
built." That assumption was wrong: re-reading `dungeon-runner.mjs`'s
`roomsToEagerlyBuild` and `dungeon-app.mjs`'s `startDungeonRun` loop, this
module performs **eager, full-graph pregeneration** — every room is built
in one topologically-ordered loop, over the *complete, already-known*
`state.layoutEdges`, before the party can enter the scene at all. There is
no per-room building as the party advances; the only other build path
(`resolveCurrentRoom`'s "ensure-built" check) is a failure-retry safety
net for a room the eager loop's own try/catch swallowed an error for, not
a routine ordering path.

Because the whole graph is known before any room's walls are created,
there is no room-build-ordering hazard to design around, and no scene
Wall-document patching is needed. The correct mechanism is simpler than
either registry design considered before: a **pure, stateless check**,
embedded in `buildRoomAtGraphNode` (or a helper it calls), that scans
`state.edges` fresh on every call — the same way that function already
builds `occupiedCells` fresh from `state.layoutPositionByRoomId` on every
call — to determine whether any *other* edge's dogleg needs to open a
foreign gap in *this* room's own margin. It is correct on first build for
every room, whether built eagerly or (in the rare failure-retry case)
lazily, because it is recomputed identically each time rather than reading
back some earlier snapshot.

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

## Round 2: co-parent collision (found by final review, 2026-09-29)

### What Round 1 got wrong

Round 1 (the margin-aware dogleg above) was fully implemented (6 tasks,
every task individually reviewed clean across several fix rounds, full
test suite green, a dedicated system-wide sweep asserting zero
corridor/footprint overlap). The final whole-branch review, instead of
trusting the hand-built single-incoming-connection graphs every Round 1
test used, built its own verification against **real** per-connection
door-slot allocation (`incomingConnectionsFor`'s actual N-slots-per-room
behavior), the real live-reported seed, and a 500-seed corpus with real
multi-parent merge rooms — and found Round 1 is a **net connectivity
regression** on real merge rooms:

- The blocking room, in the overwhelming common case (375/380 measured
  dogleg activations), **is itself one of the target merge room's own
  real parents** — a co-parent, not an unrelated sibling. Round 1's own
  dogleg, routing into that co-parent's margin band, pushes a new wall
  into the co-parent's own door slot: **375/380 activations now seal the
  co-parent's own door shut**, against 17/380 before Round 1 (measured on
  the same edges, same corpus, pre- vs. post-Round-1).
- The co-parent's own corridor to the same target already occupies the
  exact margin band Round 1's dogleg (turn 2 especially) routes through —
  **374/380 activations have the co-parent's own corridor walls crossing
  the dogleg's own lane/turn-2 segments.**
- A separate, independent defect in `pendingForeignMarginOpenings`
  (assumes a single full-width incoming slot instead of the real
  per-connection slot) leaves the real door still covered in 323/380
  (85%) of cases regardless of the above.

Every Round 1 test happened to use a graph with exactly one incoming
connection per room, which is precisely the configuration that hides all
three defects — a merge room (2+ real parents) never appeared in any
Round 1 test's own graph construction. Full detail, hand-traced examples,
and the exact measurement methodology are preserved in the SDD ledger at
`.superpowers/sdd/2026-09-29-merge-room-gate-share/progress.md` (not
reproduced here — this spec states the finding and the fix, not the full
review transcript).

### Decision

Round 1's dogleg is **kept**, unmodified, for the case it was actually
built and verified for: a blocking room that is genuinely unrelated to
the target (not one of its own real parents) — the original live-reported
scenario, where the blocker (`room-room-room-entry-0-1`) and the merge
room's actual co-parent (`room-detour-0`) were two different rooms.
Round 1's own internal geometry (the dogleg's turn/lane/turn-2 shape,
`cellMarginWalls`'s generalization to multiple openings per side) was
independently hand-traced and confirmed sound by the final review; only
its *trigger scope* was too broad, applying dogleg routing even when the
blocker turned out to be a co-parent whose own corridor was already
present.

A new mechanism, described below, handles the co-parent case: **the
second edge's corridor rides along the co-parent's own already-built
corridor for the shared stretch, instead of drawing new geometry through
the same space, then branches to its own separate door near the
target.** Chosen over two alternatives considered and rejected:

1. *One shared physical door for both parents.* Rejected: would require
   reworking `incomingConnectionsFor`'s one-slot-per-connection model and
   the unlock/reveal machinery's single-`dungeonDoorFromRoomId`-per-door
   assumption — a much larger, riskier change than this bug warrants.
2. *Narrowly exempt a co-parent's cell in `findCorridorPath`, routed
   through the general multi-cell BFS.* Rejected: this is a tightly-scoped
   revival of #174's own FIRST reverted attempt (exempting
   `legitimateSourceIds` from `isBlocked`), which was found unsound
   because it let a path route through a co-parent's own real room as if
   it were empty transit space, potentially walling that co-parent's own
   door. Narrowing the exemption to only the specific collision case this
   spec addresses reduces but does not eliminate that risk, and reuses
   less-well-understood machinery than the alternative below.

### Detection

Purely a lookup against data the caller already has — no new geometry
computation. `buildPopulateAndUnlockGraphNode`'s own incoming-connections
loop (`scripts/dungeon-scene.mjs`) already holds, for the room currently
being built, every one of its real parents
(`incomingConnectionsFor(layoutEdges, roomId, hiddenIncomingByRoomId)`).
For a given connection whose own candidate corridor (computed exactly as
Round 1 already computes it) comes back with a non-null `foreignOpening`
(meaning Round 1's own dogleg trigger fired), check whether
`foreignOpening.roomId` is *also* one of this same room's own real
parents (i.e. appears as a `sourceId` in this same `incomingConnections`
list). If yes: co-parent collision, handled by the mechanism below. If
no: unchanged — Round 1's own dogleg fires exactly as before, for a
genuinely unrelated blocker.

### Two-pass connection building

Today, `buildPopulateAndUnlockGraphNode`'s loop computes and commits each
incoming connection's own geometry in one pass, in
`incomingConnectionsFor`'s own list order (real parents in
`Object.entries(layoutEdges)` order, then hidden). That order does not
guarantee a co-parent is processed before a connection that needs to ride
along it. The loop splits into two passes:

- **Pass 1:** for every incoming connection, compute its own candidate
  corridor exactly as today (`buildEdgeCorridor`, including Round 1's own
  dogleg logic) — but do not yet create any Foundry Wall/Tile documents.
  Hold each connection's own result, indexed by its position in the list.
- **Pass 2:** walk the list again. A connection with no co-parent
  collision (per Detection, above) commits its pass-1 result exactly as
  Round 1 already does — byte-identical behavior for every room that
  isn't a multi-parent merge room affected by this specific collision.
  A connection *with* a collision builds the ride-along geometry below,
  using its own pass-1 result (for its own source-side approach, up to
  the point of convergence) together with the *already-known* co-parent
  connection's own pass-1 result (for the shared stretch) — available
  regardless of which one came first in the list, because both were
  computed in pass 1 before either was committed.

### Ride-along geometry

Round 1's dogleg routed its "lane" to the blocking room's own **east
margin edge** (`occupantRect.gx + occupantRect.gw`) — a location with no
particular meaning beyond "just outside the room's footprint." The new
mechanism instead routes the second edge's own approach segment (the
mirror of Round 1's "turn 1," still built the same way, still confined to
the *source's own* margin band per Round 1's own established reasoning:
there is no y-range/x-range inside the blocking cell itself where turning
wouldn't overlap the blocking room's own floor) to converge on the
co-parent's own **actual corridor floor position** — wherever the
co-parent's own `buildEdgeCorridor` call (from pass 1) actually placed
its own door and corridor segments, not an arbitrary margin-edge
coordinate.

From that convergence point onward, the second edge's own corridor
**reuses the co-parent's own already-computed `corridorSegments` and
`plainWalls` verbatim** for the entire shared stretch through the
blocking room's own margin and into the target's own cell boundary — no
new floor, no new walls, for that shared span, because nothing new is
being drawn there: the co-parent's own already-reviewed corridor already
occupies it correctly. This is what makes the design correct by
construction rather than by coordination: there is no second, independent
geometry computation for the shared span that could disagree with the
first.

Near the target, the second edge needs its own separate door (per Two-
pass, above — the door/flag model is unchanged), so its corridor
**branches off the shared floor with one short new segment**, diverging
to its own door slot on the target's face (allocated by
`doorSlotsForFace` exactly as today — this connection still occupies its
own slot index in `incomingConnectionsFor`'s own list, same as any other
connection; only its *corridor geometry*, not its slot allocation,
changes). This new branch segment needs its own containment (same "seal
everything except the declared opening" discipline as every other new
wall in this file), scoped precisely to its own short span — not the
whole shared stretch, which needs no new containment because the
co-parent's own walls already fully contain it.

### Doors and flags unchanged

Both connections keep fully independent doors: their own
`dungeonDoorToRoomId`/`dungeonDoorFromRoomId` (or, for a hidden
connection, `dungeonHiddenDoorForEdge`) flags, their own unlock/reveal
behavior, their own entry in `incomingConnectionsFor`'s own list, exactly
as Round 1 and every prior fix in this file already built. Only the
*corridor geometry* for the colliding connection changes — from an
independent (and, per the final review, unsound) dogleg into a shared-
floor ride-along with one new branch. `handleDungeonDoorOpened`,
`unlockDoorsFromRoom`, and every other consumer of these flags needs no
change.

### Scope

Covers exactly the collision case the final review measured: a merge
room with (at least) two real parents, where the second parent's own
null-path fast-path fallback is blocked by a cell occupied by the *first*
(co-parent) real parent. Explicitly out of scope, left as documented
residuals, same pattern as every other residual in this file:

- Three-or-more real parents all colliding at the same intermediate cell
  (a co-parent's own corridor being itself blocked by a *second*
  co-parent). Not observed in the measured corpus; the two-pass
  restructuring's own detection only checks a single co-parent match.
- The generic corner-fallback branch, and two-or-more consecutive
  blocking cells — already out of scope per Round 1's own Scope section,
  unchanged.
- A co-parent collision where the co-parent's *own* connection also needs
  Round 1's dogleg (i.e. the co-parent's own edge is itself boxed in by a
  third room). The ride-along mechanism reuses whatever the co-parent's
  own pass-1 result actually is, dogleg or not, so this composes
  correctly in principle, but was not specifically measured.

## Testing

**The central lesson from Round 1's own final review, binding on every
test in Round 2:** a test graph with only one incoming connection per
room cannot exercise, and therefore cannot catch a regression in, any of
this: `incomingConnectionsFor`'s real multi-slot allocation, a co-parent
collision, or the ride-along mechanism itself. Every Round 2 test below
must use a graph where the target has **two or more real parents**, with
real per-connection slots resolved via `incomingConnectionsFor`
(`doorSlotsForFace(rect, incomingConnections.length, incomingFace)[i]`),
not a hand-built single-slot `doorSlotsForFace(rect, 1, face)[0]` — the
exact construction that hid all three Round 1 defects.

- A dedicated regression test reproducing the live-reported seed's own
  **real graph** (not a hand-built approximation): a merge room with (at
  least) two real parents, where one parent's edge is blocked by the
  other. Assert, for BOTH connections into the merge room: no corridor
  segment overlaps any other room's own footprint (Round 1's own
  property, still required); the corridor is connected end-to-end from
  its own source door to its own target door (not just non-overlapping —
  Round 1's own Critical-1 finding was a corridor that avoided the
  blocker but never reached its own door); and neither connection's own
  door/corridor is sealed shut by the other's walls (Round 2's own
  Critical-1/2 finding).
- A sweep assembled the same way as the #294/Round-1 sweep, but built
  with **real** `incomingConnectionsFor`-resolved slots throughout (not
  the count-1 assumption Round 1's own sweep used), asserting the real
  downstream properties, not a proxy: zero corridor/footprint overlap
  (Round 1's own property), plus zero cross-connection wall collisions —
  no connection's own `plainWalls` may be collinear with another
  connection's own `doorWall`/`revealDoorWall` into the same target room
  — and, ideally, a real reachability check (e.g. a flood-fill from each
  `doorWall` to its own `revealDoorWall` through the connection's own
  floor tiles) rather than trusting wall/floor construction alone to
  imply connectivity.
- `pendingForeignMarginOpenings` (or its Round 2 equivalent, if the
  implementation plan restructures it) must resolve the real per-
  connection slot for a foreign opening, not assume a single full-width
  slot — the specific, independently-confirmed defect behind Round 1's
  own 85% door-coverage failure.
- A scene-level test (`tests/dungeon-scene.test.mjs`) building a real
  multi-parent merge room end-to-end through `buildPopulateAndUnlockGraphNode`,
  confirming the actual Wall/Tile documents produced for both connections
  are consistent with each other — not just that `buildEdgeCorridor`'s
  own pure return value looks right in isolation.
- Live Foundry verification against the exact reported seed once merged,
  per this session's established practice.

## Success criteria

- The reported live scenario (seed `1790705053246-4vdgop9m7i5`, edge
  `room-room-entry-0` → `room-room-room-entry-0-0`) no longer produces a
  corridor overlapping `room-room-room-entry-0-1`'s footprint (Round 1's
  own criterion, still required).
- On a **real, multi-parent merge room** (not a hand-built single-
  connection graph): both the co-parent's own connection and the second
  parent's own (now ride-along) connection remain independently
  connected end-to-end, with neither connection's own door sealed by the
  other's walls. This is the criterion Round 1 never actually measured
  and that its own final review found violated in 374-375 of 380 cases.
- System-wide sweep, built with real per-connection slots: zero corridor/
  room-footprint overlaps AND zero cross-connection wall collisions, for
  the collision case this round covers.
- No regression in existing #225/#230/#288/#294 coverage, nor in Round
  1's own (still-kept, for the unrelated-blocker case) dogleg coverage —
  full test suite green, existing sweeps' own assertions unchanged in
  outcome.
- Any remaining collision case (three-or-more real parents at one cell,
  two-or-more consecutive blockers, or the generic corner-fallback
  branch) is measured and documented as an explicit residual, not
  silently left uncovered.
