# Branching dungeon topology, full pregeneration, and removed GM approval — design

**Tracks:** [#93](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/93)

**Builds on:** [#62](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/62)
(GM-less eager pregeneration, merged) — that work established idempotent
per-room build steps and the eager-build/physical-slot bookkeeping this
design generalizes to a graph. #93's own text raised resolving #62's
blocked goal-room-relocation question together with this issue; #62 has
since been fully resolved and merged independently (its own goal-room
outgoing-connection retrofit), so this design does not need to revisit
that question — it inherits a working eager-build foundation to extend.

## Problem

Every dungeon today is linear: a single ordered room sequence
(`dungeon-deck.mjs`'s `buildRoomSequence()`), one door in and at most one
door onward per room, laid out on the Foundry canvas as a boustrophedon
(snake) walk (`dungeon-layout.mjs`'s `slotRowCol`/`slotRect`). This should
become a branching topology: every room except the initial safe/narrative
entry room (index 0, never counted toward dungeon size) can have multiple
exits, while the goal room stays a sink with exactly one entrance — every
branch eventually converges on it.

A branching layout can't be discovered and built one room at a time as the
party walks through it (today's lazy, per-door build in
`dungeon-runner.mjs`/`dungeon-scene.mjs`). Multiple exits per room means
the dungeon's shape has to be decided as a whole graph up front, at
scene-creation time — for every run, not just GM-less ones (a superset of
#62's GM-less-scoped ask). Once population happens as a single up-front
bulk pass across dozens of rooms, the synchronous per-room GM Accept/Reroll
approval gate (`encounter-generator.mjs`'s `showEncounterPreview`) no
longer works and is removed entirely.

## Investigation

- **Current data model is a flat array + scalar cursor.** `state.rooms` is
  an ordered array; `state.currentIndex` is the party's position;
  `dungeon-scene.mjs`'s `handleDungeonDoorOpened` only ever checks
  `state.rooms[state.currentIndex + 1]` — there is no concept of "more than
  one next room." `physicalSlotByRoomId` maps a room id to its array index,
  which `dungeon-layout.mjs` treats as the sole input to geometry
  (`slotRect(seed, slot)`, `slotRowCol`, `connectionDirection`) — a pure,
  pre-branching cumulative walk from slot 0.
- **#62's eager build is already generalizable.** `roomsToEagerlyBuild`,
  `commitEagerPhysicalSlots`, and the idempotent `buildPopulateAndUnlockRoom`
  / `populateSlot*` / `ensure*` build steps it introduced don't inherently
  require a flat array — they operate per-room, keyed by id and slot. The
  main change this design needs from that foundation is: walk a graph in
  topological order instead of an array in index order, and stop scoping
  the eager path to `state.hostUserId` (GM-less only) — it now applies to
  every run.
- **Accept/Reroll is already partially bypassed.** `skipPreview =
  Boolean(run?.hostUserId)` in `encounter-generator.mjs` already skips the
  dialog for GM-less runs. #93 asks to remove it outright, for every run —
  `showEncounterPreview` and its Accept/Reroll UI become dead code to
  delete, not a condition to extend.
- **The first-combat-room manual deferral (ITEM-11) is superseded.**
  `startDungeonRun` currently skips eagerly building `state.rooms[1]` if
  it's combat-kind, deferring it to the manual "Populate Next Room" button.
  That deferral existed to pace around per-door lazy building and the
  Accept/Reroll dialog — both gone once every room (including the first
  combat room) pregenerates as part of the graph. Removed as part of this
  work, not carried forward.
- **Reward/Ruin sequence mutations don't fit a fixed pregenerated graph.**
  `applySequenceMutation`'s `insert_after`/`remove_next` splice a flat
  array at a not-yet-built index — a model that assumed lazy, incremental
  extension. Once the whole graph (including the goal's convergence point)
  is fixed at generation time, live graph surgery has no clean meaning.
  Confirmed with Cory: these two outcomes are redefined (not dropped, not
  simply disabled) to *reveal a pregenerated-but-hidden* shortcut or
  detour, never to insert or remove nodes at runtime.

## Decision

Confirmed with Cory across several rounds:

1. **Layout:** a full graph/tree layout — arbitrary branch depth and width,
   positioned by a real rank-based tree-layout algorithm — not a bounded
   trunk-with-side-branches extension of the existing snake grid.
2. **Branch degree:** frequent branching, capped at 2 extra exits per
   non-entry/non-goal room (3 total exits at most), via a new tunable
   weighted table in the same spirit as `ROOM_KIND_WEIGHTS`.
3. **Sequence mutations:** `reduced_travel_time` and `extra_travel_time`
   stop mutating anything at runtime. Generation pregenerates optional
   hidden shortcut edges and detour rooms along branches; resolving these
   two outcomes reveals (unlocks) a pregenerated shortcut or detour rather
   than building or splicing anything new.
4. **GM approval:** `showEncounterPreview`/Accept-Reroll is deleted
   outright. No opt-in path survives.
5. **Scope:** full pregeneration applies to every run, GM-present and
   GM-less alike (superset of #62). The ITEM-11 first-combat-room manual
   deferral is removed as part of this change.

## Architecture

### Data model

- `state.rooms`: `{roomId: RoomNode}` (was an ordered array). A `RoomNode`
  keeps today's fields (`kind`, `isGoal`, `setpieceId`, `outcomeSlotId`,
  `locationTag`, `artVariant`) plus `id`.
- `state.edges`: `{roomId: roomId[]}` — a room's exits, in stable
  generation order (index within the array is that room's stable "exit
  slot," used later to map a specific door to a specific child).
- `state.currentRoomId`: replaces `state.currentIndex`.
- `state.history`: a list of visited room ids, replacing index-based
  history.
- `physicalSlotByRoomId` keeps its existing role as a monotonic per-room
  build-order/identity token (idempotency bookkeeping, unchanged
  semantics) but is no longer the input to geometry.
- New `layoutPositionByRoomId: {roomId: {rank, col}}`, produced by the
  layout pass (see below) and consumed by `dungeon-layout.mjs`'s geometry
  functions in place of a bare slot integer.
- Hidden-content flags: a `RoomNode` gains `hidden: boolean` (detour rooms,
  `false`/absent for normal rooms) and an edge gains a parallel
  `hiddenEdges: {roomId: roomId[]}` map for shortcut edges not selectable
  as a door until revealed.

### Graph generation (`dungeon-deck.mjs`)

`buildRoomGraph({ seed, roomCount, ... })` replaces `buildRoomSequence()`:

- Seeded frontier walk starting from the entry room (room 0, unchanged:
  always safe, never counted toward `roomCount`).
- Maintains a set of open branch "tips" (leaf rooms still awaiting
  children). At each step, pop a tip, assign it room content the same way
  `roomKindAt`/`setpieceAt`/etc. already do (unchanged per-room content
  logic), then roll its exit count via a new `EXIT_COUNT_WEIGHTS` table
  (frequent branching, capped at 3 total exits — 1-2 "extra" beyond the
  first). Push one new tip per exit.
- As the room budget (`roomCount`) runs low, generation stops opening new
  branches and instead **forces merges**: multiple open tips are routed to
  the same next room (that room gets multiple incoming edges) until
  exactly one tip remains. That final tip is the goal room's sole parent —
  this is what guarantees the single-entrance goal regardless of how much
  branching happened upstream, including staged merges before the final
  one if there were many tips open at once.
- For a configurable fraction of branch edges, generation also pregenerates
  one optional hidden extra: either a shortcut edge (an edge from the
  current room directly to a room 2+ hops further along the same branch,
  skipping the room(s) between) or a detour room (an extra node spliced
  hidden between two already-generated adjacent rooms). Both are flagged
  hidden and excluded from the normal `roomCount` budget — same treatment
  as today's mid-dungeon rest room, which is also inserted outside the
  budget.
- `outcomeSlotAt` keeps assigning Reward/Ruin outcome slots per room
  exactly as today; only what `reduced_travel_time`/`extra_travel_time`
  *do* when resolved changes (see Data flow).

### Layout (`dungeon-layout.mjs`)

- Rank-based placement: `rank(room) = 1 + max(rank(parent) for parent in
  incoming edges)`, entry room at rank 0. This is a topological level, not
  a physical row — merge rooms take the max over all their parents.
- Within a rank, rooms are ordered left-to-right by generation order (a
  stable DFS pre-order over the graph), a heuristic that doesn't attempt
  optimal crossing minimization — good enough for the dungeon sizes this
  module already targets (YAGNI: a real crossing-minimizing tree-layout
  algorithm is not warranted here).
- Column (x) assignment is a two-pass tree-layout: bottom-up, each room's
  required width is the sum of its children's required widths (leaf width
  = the room's own footprint from `roomSizeAt`, same weighted small/large
  pick as today); top-down, each room is centered over its children's
  combined span. Merge rooms (multiple parents) are positioned once, under
  whichever parent subtree claims them per the stable DFS order, and every
  other parent's corridor routes to that shared position.
- Corridors: a straight corridor when parent and child share a column
  (reusing `CORRIDOR_LEN`/`DOOR_WIDTH` exactly as today); an L-shaped
  two-segment corridor otherwise (one segment changing rank/row, one
  changing column), built from the same tile-placement primitives
  `buildConnectionGeometry` already uses. `roomEnclosureWalls`/
  `outgoingFaceWall` extend from "one outgoing face" to "one outgoing face
  per edge" — a room with 2-3 exits gets that many flagged frontier
  placeholder walls instead of one.

### Room population (`dungeon-runner.mjs`)

- `roomsToEagerlyBuild(state)` becomes a topological-order walk over the
  graph (a room is only built after all its parents), building every
  room's full content — walls, encounter, trap/puzzle/skill-challenge,
  treasure — for every run, GM-present or GM-less alike. No more
  `hostUserId` branch.
- Hidden detour rooms are built too (content fully generated, same as any
  other room) but their connecting doors stay sealed/unbuilt until
  revealed.
- The ITEM-11 first-combat-room deferral is removed; every room, including
  a combat-kind room at generation-order position 1, is pregenerated like
  the rest.
- `showEncounterPreview` and the Accept/Reroll UI in
  `encounter-generator.mjs` are deleted; `generateEncounter` always
  proceeds straight to acceptance.

### Traversal / door handling (`dungeon-scene.mjs`)

- `handleDungeonDoorOpened(sceneId, wallId)` maps `wallId` → a specific
  door → a specific child room id, via a `doorToRoomId` lookup built
  during the layout/build pass (one entry per built frontier-placeholder
  or real door wall). This replaces today's single
  `state.rooms[state.currentIndex + 1]` check.
- Opening any of the current room's doors sets `state.currentRoomId` to
  that specific child and appends to `state.history`. Sibling branches not
  chosen are already fully pregenerated but are never visited — their
  built content simply goes unused; nothing is torn down, no orphan
  bookkeeping is needed (consistent with #62's precedent that an unused
  trailing/extra slot is harmless).
- Revealing a hidden shortcut/detour (`reduced_travel_time`/
  `extra_travel_time` resolving) only ever affects rooms **ahead of**
  `state.currentRoomId` on the branch actually being walked — same
  "never touches an already-built/already-visited room" invariant
  `applySequenceMutation` relied on today, just re-expressed as "which
  pregenerated edge is currently selectable" instead of "splice the
  array." Concretely: revealing a shortcut unlocks its door (bypassing the
  skipped intermediate room(s), which become unused exactly like any
  other unchosen branch); revealing a detour unlocks the door into the
  detour room and re-routes the "onward" door so the party must pass
  through it before reaching the room it was hidden in front of.

### Goal convergence

Generation guarantees a single "final convergence room" that every
surviving branch flows into, possibly through several staged merges
upstream, and that room is the goal room's one and only parent. This
satisfies #93's "goal room has a single entrance" requirement exactly,
regardless of how much branching and merging happened earlier in the
graph.

## Data flow

- **Scene creation (every run):** entry room placed; `buildRoomGraph`
  generates the full DAG (including hidden shortcuts/detours) up front;
  the layout pass assigns `layoutPositionByRoomId` and computes every
  corridor; `roomsToEagerlyBuild`'s topological walk builds every room's
  full content, including hidden ones (sealed). Only the entry room's
  doors unlock immediately; everything else stays locked until reached.
- **Normal progression:** `handleDungeonDoorOpened` resolves which child a
  chosen door leads to via `doorToRoomId`, advances `currentRoomId`, and
  unlocks that room's own outgoing doors (excluding any still-hidden
  shortcut/detour doors).
- **A `reduced_travel_time`/`extra_travel_time` outcome resolves:** the
  outcome handler looks up the pregenerated hidden shortcut/detour
  attached to the room whose outcome just resolved, unlocks the relevant
  door(s), and (for a detour) re-routes the "normal" onward door to
  require passing through the detour room first. No new content is built
  and no existing content is torn down — everything needed was already
  constructed during scene creation.

## Error handling

Every individual room build step remains the same idempotent,
already-guarded call `roomsToEagerlyBuild`'s topological walk invokes
per-room (unchanged from #62). A partial failure partway through the
initial full-graph pregeneration pass leaves downstream rooms unbuilt —
since the manual "Populate Next Room" recovery path (ITEM-11) is removed,
recovery is instead a lazy fallback: if the party's progression ever
reaches a room whose content wasn't successfully built during
pregeneration, the same idempotent build step runs on demand (the same
call the eager pass already used, just invoked later) before the room is
revealed. This preserves a safety net without reintroducing a live
per-door dependency as the *normal* path — it only ever engages after an
actual build failure.

## Testing

- Unit test `buildRoomGraph`: deterministic given a seed; every generated
  graph is a DAG (no cycles); the goal room has exactly one incoming edge
  regardless of `roomCount` or branch-degree rolls; every non-entry,
  non-goal room has 1-3 exits per `EXIT_COUNT_WEIGHTS`; hidden
  shortcuts/detours never target or originate from the entry or goal room.
- Unit test the forced-merge behavior directly: seed the frontier walk
  with a room-count budget small enough to force merges early, and assert
  the resulting graph still converges to a single goal parent.
- Unit test the layout pass: rank is a valid topological level for every
  room; no two same-rank rooms' footprints overlap; a merge room's
  position is consistent regardless of which parent's subtree it's
  reached through.
- Unit test `doorToRoomId` construction and `handleDungeonDoorOpened`'s
  resolution against a small fixture graph with at least one 2-exit room
  and one merge room.
- Unit test the shortcut/detour reveal logic: resolving
  `reduced_travel_time` unlocks exactly the shortcut door and leaves
  skipped rooms unused; resolving `extra_travel_time` unlocks the detour
  door and re-routes the onward door; neither ever touches a room already
  in `state.history`.
- `dungeon-scene.mjs` wall/geometry changes verified via live verification
  and hand-trace, same fallback pattern #62 established (no Foundry test
  harness exists for that boundary).

## Out of scope

- GM tooling for interceding in or editing a pregenerated dungeon after
  the fact (explicitly out of scope in #93's own text — tracked as later
  follow-up work).
- Measuring or optimizing the cost of building a full branching graph
  (potentially dozens of rooms) in one pass at scene-creation time.
- Any crossing-minimizing (as opposed to stable-DFS-order) refinement to
  the layout pass's same-rank room ordering.
- Reworking room-kind/outcome-slot assignment itself — unchanged from
  today, only the graph shape and mutation semantics around it change.
