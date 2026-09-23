# GM-less dungeon precalculation — design

**Tracks:** [#62](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/62)

## Problem

A GM-less run has a hard runtime dependency: room content (walls, encounters,
traps, puzzle state, treasure) is built lazily, one room at a time, as the
party reaches each door (`buildPopulateAndUnlockRoom`,
`dungeon-scene.mjs:753`, run from `resolveCurrentRoom`, `dungeon-app.mjs:190`,
plus rooms 0+1 at run start via `startDungeonRun`, `dungeon-app.mjs:353`).
Every one of those builds requires a GM-privileged client
(`dungeon-permissions.mjs`); a non-GM client relays the request
(`dungeon-remote.mjs`) to a live GM/Agent-GM client instead of acting
directly. If that privileged client isn't connected at the exact moment a
door opens, the party is stuck (`PF2EDC.Dungeon.RequestFailedWarning`).

## Investigation

- **Call chain.** The door-open hook itself (`handleDungeonDoorOpened`,
  wired to Foundry's `updateWall`) does not build content — it only reveals
  already-placed tokens and advances `currentIndex`. The actual build runs
  one room ahead, inside `resolveCurrentRoom` when the *current* room's
  outcome resolves, plus rooms 0+1 at run start. All build steps
  (`buildRoomAtSlot`, `populateSlotEncounter`, `populateSlotTrap`,
  `ensurePuzzleState`, `ensureSkillChallenge`, `ensureNarrativeState`,
  `unlockDoorToSlot`) are already idempotent/guarded — safe to call more
  than once.
- **Scene model.** One single Foundry Scene ("Dungeon Crawl") holds the
  whole run as a growing physical grid, created once in `startDungeonRun`
  and resized as rooms are built (`ensureSceneCovers`, `dungeon-scene.mjs`).
  Not one Scene per room.
- **GM-less detection.** No explicit "GM-less mode" flag exists today.
  `run.hostUserId` records who started the run; `canActOnDungeon`
  (`dungeon-permissions.mjs:21`) authorizes a GM always, and a non-GM only if
  they're the tracked host. "GM-less" is circumstantial, not a persistent
  mode — the risk is a privileged client not being live at the moment a
  build is needed, not the permanent absence of one.
- **Sequence mutations — the crux.** `applySequenceMutation`
  (`dungeon-deck.mjs:312`), run from `markRoomOutcome`
  (`dungeon-runner.mjs:177`) whenever a Reward/Ruin resolves, only ever
  splices at `currentIndex + 1` — a room that has never been assigned a
  physical slot or built yet. That's exactly why the current lazy design has
  no reindexing problem. It also means **which mutations fire is not
  knowable until the run is actually played** (they depend on live outcomes
  — skill checks, earlier-room results), so "precalculate the whole
  dungeon" can only ever mean precalculating the deterministic *base*
  sequence from `buildRoomSequence()`, never a mutation-inserted room that
  doesn't exist yet at scene-creation time.
- **First-room combat deferral.** `startDungeonRun` deliberately skips
  building `state.rooms[1]` if it's combat-kind (ITEM-11), deferring it to
  the manual "Populate Next Room" button instead. No documented rationale
  found (no backlog entry, no commit message) — noted here, not resolved.
  Separately: Cory's stated intent is that this room should always be a
  safe Narrative-kind entry room that doesn't count toward dungeon size —
  current code doesn't enforce that (recorded as background project
  knowledge, not in scope for this design).
- **Cost.** No existing performance measurement. Each room's build is a
  handful of `createEmbeddedDocuments` calls plus a scene resize; nothing
  suggests a hard ceiling at typical dungeon lengths (~10-20 rooms), but
  this is a genuine unknown, not a confirmed non-issue.

## Decision

Precalculate the base sequence. Keep the first-room combat deferral
unchanged for GM-less runs too (confirmed with Cory) — this design does not
touch room-kind assignment.

**Revised after implementation surfaced a real gap (2026-09-22):** the
original version of this section said sequence mutations would be "left
exactly as they are." A subagent-driven implementation pass built exactly
that, passed its own per-task reviews, and then failed final whole-branch
review: mutations physically strand the party. `buildRoomAtSlot` connects
slot N to slot N-1 only (`dungeon-scene.mjs`, `buildConnectionGeometry`) —
a fixed linear corridor poured for the *whole* eagerly-built sequence before
any mutation is known. `applySequenceMutation`'s splice only ever changes
which LOGICAL room a slot corresponds to; it does nothing to the PHYSICAL
walls already built between consecutive slot numbers. A `remove_next`/
`insert_after` (routine — either fires whenever a `reduced_travel_time`/
`extra_travel_time` outcome template resolves, not a rare edge case) leaves
a door with nothing real behind it, or nothing real in front of it. Full
trace: `.superpowers/sdd/2026-09-22-gmless-dungeon-precalculation/final-review-fix-report.md`
in the worktree that found it.

Cory's choice among the options this surfaced: **reconcile physical slots
with the mutated logical sequence, rather than disabling mutations or
capping eager-build short of them.** The mechanism below is *not* "rebuild
the corridor" literally — investigation (`dungeon-scene.mjs`/
`dungeon-layout.mjs`) confirmed room geometry (walls, floor shape, the
slot-to-slot corridor) is a pure function of `(seed, slot, isGoal)` only,
never of room *kind* — so the corridor between consecutive slot numbers
never needs to change shape. What needs to change is which logical room's
*content* (encounter/trap/puzzle/skill-challenge/narrative state) occupies
a given already-built slot.

**Second gap, found the same way as the first (2026-09-22, later the same
day):** Tasks 3-6 implementing the mechanism above were built, individually
task-reviewed, and passed — then failed final whole-branch review again.
The claim "`applySequenceMutation` already refuses to mutate the goal room...
so the one room whose geometry is genuinely special can never be a
mutation's target" (the original version of this paragraph) was true but
incomplete: the goal room itself is never REPLACED by a mutation, but
`insert_after` always splices before it (the goal is always last), so the
goal always SHIFTS to a new, higher slot number — and the room that ends up
occupying the goal's OLD slot number is a regular, non-goal room that needs
a real outgoing connection. That slot's geometry was built with
`hasOutgoing: false` (`roomEnclosureWalls(seed, slot, {hasOutgoing: false})`,
`dungeon-scene.mjs`'s `buildRoomAtSlot`), which means **no wall exists on
that face with any flag at all** — unlike a normal (non-goal) room's
outgoing face, which always gets a temporary, flagged placeholder wall
(`dungeonFrontierWallForSlot`, see below) precisely so it can later be found
and superseded. A goal room, having no outgoing face by design, never gets
that placeholder — so there is nothing to find. This is routine (any
`extra_travel_time` outcome), not an edge case.

Cory's choice: **option 1 — tag enclosure walls with a flag**, lifting this
plan's prior blanket ban on touching `buildRoomAtSlot`/`dungeon-layout.mjs`,
scoped narrowly to *adding metadata to walls already being created*, never
changing their geometry/shape/position. This turned out to have a direct,
existing precedent to extend rather than a new mechanism to invent:
`buildRoomAtSlot`'s own `if (!isGoal)` branch (`dungeon-scene.mjs:269-281`)
already creates exactly this kind of placeholder — a temporary wall on a
room's outgoing face, flagged `dungeonFrontierWallForSlot: slot`, deleted
and superseded by real door/corridor geometry the moment the next room
actually gets built (the same `if (slot > 0)` block just above it, lines
190-215, already contains the find-and-delete logic for that flag). The fix
is to give a goal-turned-non-goal slot the same retrofit: tag every regular
enclosure wall (`roomEnclosureWalls`'s output, currently built with no flags
at all via a bare `wallDoc(side)`) with its slot and direction, so the ONE
enclosure wall on a former goal's connection-direction face can be found and
deleted, then replaced with the same frontier-placeholder wall a normal
room would have had from the start — after which the existing, unmodified
`if (slot > 0)` supersede-on-next-build logic just works, no further new
code needed downstream.

No new "GM-less mode" flag: reuse the existing `hostUserId` signal —
confirmed via implementation to be `state.hostUserId` truthiness directly
(the same signal `unpauseIfGmLessRun`, `dungeon-combat.mjs:209`, and
`encounter-generator.mjs`'s `skipPreview`, line 201, already use), not a
`game.users.get`/`isGM` lookup. `startDungeonRun` already has `hostUserId`
as a parameter and threads it into `state`, so no new resolution step is
needed at all.

### Mutation reconciliation (added after the revised Decision above)

Three pieces of new work, none of which touch corridor/wall geometry:

1. **An `unlock` option on `buildPopulateAndUnlockRoom`** (`dungeon-scene.mjs`,
   signature `scene, state, room, physicalSlot`), defaulting to `true`
   (unchanged behavior for the existing GM-hosted lazy path). The eager
   GM-less loop passes `unlock: physicalSlot === 1` — only the room the
   party starts adjacent to unlocks immediately; every other eagerly-built
   room's door stays locked until the party's actual progression reaches
   it, exactly matching what "resolution order" already means for a
   GM-hosted run. (This also happens to be a real, independently-confirmed
   bug in the current implementation of Task 2 below: it unlocks every
   eagerly-built door unconditionally, which defeats the resolution-order
   gate even with no mutation involved — fix this regardless of the
   mutation work.)

2. **One teardown function per content type** — none exist today (confirmed
   by grep: zero clear/delete/remove/reset/teardown exports in
   `dungeon-runner.mjs`; `sweepLooseNpcActors` in `dungeon-scene.mjs` is an
   end-of-run/abandon-time sweep, not a per-slot operation). Needed for:
   encounter (`populateSlotEncounter`'s spawned tokens/actors), trap
   (`populateSlotTrap`'s hazard actor), puzzle/skill-challenge/narrative
   (their room-keyed state in the `dungeonRuns` setting). Each mirrors its
   own `ensure*`/`populate*` counterpart closely enough to sit next to it.
   `isSlotBuilt`/`isSlotPopulated` (`dungeon-scene.mjs:391-403`) check
   presence, not identity — re-populating an already-occupied slot without
   tearing it down first would layer new content on top of stale content,
   not replace it, so teardown must run before any re-population.

3. **A mutation-triggered re-sync step**, wired into the same place
   `applySequenceMutation` already runs (`markRoomOutcome`,
   `dungeon-runner.mjs:177`) but only active for a GM-less-hosted run
   (`state.hostUserId` set) that had already eagerly built past the
   mutation point:
   - **`remove_next`:** walk forward from the mutation point, tearing down
     and re-populating each already-built slot's content for whichever
     logical room now maps to it after the splice. The trailing-most slot
     (one fewer logical room now needs a physical slot) gets torn down and
     left orphaned — confirmed harmless: scene sizing only ever grows
     (`ensureSceneCovers`, `Math.max`, never shrinks) and nothing else in
     the codebase counts physical slots against `state.rooms.length` in a
     way an extra unused trailing room would break.
   - **`insert_after`:** same forward walk and re-populate, plus one
     genuinely new `buildRoomAtSlot` call to physically extend the chain by
     one slot at the tail — the exact same call the existing lazy path
     already makes for a brand-new slot, so this needs no new geometry
     code, only invoking existing code one more time than today.
   - Because the eager-build loop runs everything at once at `startDungeonRun`
     time, by the time any mutation can fire at all (which only happens once
     a room's outcome resolves, i.e. after the run has started and the party
     has played at least one room) the entire base sequence is already
     built — there is no partial-eager-build case to handle. Re-sync always
     walks from the mutation point to the already-built tail.

4. **A goal-room outgoing-connection retrofit** (this revision's addition):
   `roomEnclosureWalls`'s consumption in `buildRoomAtSlot`
   (`dungeon-scene.mjs:184-186`) tags every regular enclosure wall with its
   slot and direction (currently untagged — a bare `wallDoc(side)`). When
   `roomsNeedingResync`'s `toRebuild` list contains an entry whose
   PREVIOUS occupant was the goal room (i.e. this slot was originally built
   `isGoal: true`, `hasOutgoing: false`), before the normal teardown/rebuild
   sequence runs: find the one enclosure wall flagged for this slot's
   `connectionDirection`, delete it, and create the same frontier-placeholder
   wall (`dungeonFrontierWallForSlot: slot`) `buildRoomAtSlot`'s own
   `if (!isGoal)` branch already creates for a normal room from the start.
   From that point on the existing, unmodified supersede-on-next-build logic
   (`dungeon-scene.mjs:190-215`) needs no further changes — it already knows
   how to find and delete a `dungeonFrontierWallForSlot`-flagged wall the
   moment the following slot gets built for real.

## Architecture

**Already implemented and verified correct (Tasks 1-6, commits through
`61ce825` on branch `worktree-agent-aa5921258df7bf67c`, all passed their own
task reviews):** `roomsToEagerlyBuild`/`commitEagerPhysicalSlots`/
`roomsNeedingResync` (pure, `dungeon-runner.mjs`), the `unlock` option and
idempotency guards on `buildPopulateAndUnlockRoom`, per-content-type
teardown functions, and the re-sync wiring into `resolveCurrentRoom`. This
is the slot-bookkeeping and content-reconciliation mechanism (items 1-3
above) — correct and does not need to change. Only item 4 (this revision)
is new, unimplemented work.

**New work this revision adds (not yet implemented):**

1. Tag `roomEnclosureWalls`'s wall documents (`dungeon-scene.mjs:184-186`,
   currently `wallDoc(side)` with no flags) with
   `{ dungeonEnclosureWallForSlot: slot, dungeonEnclosureWallDirection: side.dir }`
   — purely additive metadata, zero change to wall shape/position/count.
2. A new function, e.g. `openGoalRoomExit(scene, slot, seed)`
   (`dungeon-scene.mjs`, near `buildRoomAtSlot`): finds the wall flagged
   `dungeonEnclosureWallForSlot === slot` whose
   `dungeonEnclosureWallDirection` matches `connectionDirection(slot)`
   (`dungeon-layout.mjs`, already exported), deletes it, then creates the
   frontier-placeholder wall `buildRoomAtSlot`'s own `if (!isGoal)` branch
   already creates for a normal room
   (`wallDoc(outgoingFaceWall(seed, slot), {flags: {[MODULE_ID]: {dungeonFrontierWallForSlot: slot}}})`,
   `outgoingFaceWall` already exported from `dungeon-layout.mjs`). After
   this call, the slot behaves exactly like any other non-goal room's
   outgoing face — the existing, unmodified `if (slot > 0)` block in
   `buildRoomAtSlot` (lines 190-215) already knows how to find and supersede
   a `dungeonFrontierWallForSlot`-flagged wall the moment the next slot is
   built for real.
3. Wire it into the already-implemented re-sync step (Task 6): when a
   `roomsNeedingResync` `toRebuild` entry's `previousRoomId` was the goal
   room (checkable against `state.rooms` before the mutation, or by
   recording which room was flagged `isGoal` in the pre-mutation snapshot),
   call `openGoalRoomExit(scene, physicalSlot, state.seed)` before that
   slot's normal teardown/rebuild sequence runs.

`applySequenceMutation`, `buildConnectionGeometry`, `roomSizeAt`,
`slotRowCol`, `slotRect`, `doorOffsetAt`, and every other geometry-shape
function in `dungeon-layout.mjs` remain untouched — this fix adds wall
*metadata* and one narrowly-scoped retrofit function, it does not change
how any room's shape, size, or position is computed.

## Data flow

- **GM-hosted run:** unchanged — room 0 placed, room 1 built if non-combat,
  every subsequent room built one-ahead as outcomes resolve. Mutations are
  invisible to this path exactly as today (they only ever touch a room that
  hasn't been assigned a slot yet).
- **GM-less-hosted run, no mutation fires:** room 0 placed, then every room
  in the base sequence built immediately, each locked except slot 1. From
  then on, walking room to room needs no live privileged client — doors
  unlock as the party's progression reaches each already-built room.
- **GM-less-hosted run, a mutation fires:** `markRoomOutcome` resolves the
  current room, `applySequenceMutation` splices `state.rooms`, then the new
  re-sync step immediately reconciles every already-built slot from that
  point onward to match — still no live privileged client needed *at the
  moment the party opens the next door*, because the reconciliation already
  happened synchronously as part of resolving the room that triggered it
  (which, same as today, does require a privileged client — resolving a
  room's outcome always has). This is the actual removal of the live-GM
  dependency the issue asked for: not just "most rooms," all of them,
  including mutation-affected ones.

## Error handling

Each `buildPopulateAndUnlockRoom` call remains the same already-guarded,
idempotent call used elsewhere — a partial failure partway through the
initial eager-build loop leaves the rest in the same "not yet built" state
a normal lazy run would, recoverable via the existing "Populate Next Room"
button or the next automatic build. The new re-sync step is NOT similarly
safe to leave partial by construction — a teardown step that runs but whose
matching re-populate step then fails would leave a slot with no content at
all (worse than stale content). The re-sync function should teardown+rebuild
one slot at a time (not teardown the whole affected range up front, then
rebuild the whole range) precisely so a failure partway through leaves only
the one in-flight slot inconsistent, not the whole reconciled range.

## Testing

- Existing coverage for `roomsToEagerlyBuild` and `startDungeonRun`'s branch
  (Tasks 1-2) stays as-is.
- Unit test the `unlock` option: `buildPopulateAndUnlockRoom` called with
  `unlock: false` leaves the door locked regardless of room kind; the
  default (no option passed) is unchanged from today.
- Unit test each teardown function against a fixture with that content type
  present, asserting it's gone afterward, and against an empty slot
  (idempotent no-op, matching this codebase's existing guard conventions).
- Unit test the re-sync function against both mutation kinds: `remove_next`
  re-populates the correct shifted range and orphans exactly the trailing
  slot; `insert_after` re-populates the shifted range and extends the chain
  by exactly one slot. Both cases confirmed via the room CONTENT at each
  slot matching the post-mutation `state.rooms`, not via wall/geometry
  assertions (geometry is asserted unchanged, via the same seed/slot pure
  functions the implementation itself calls).
- `openGoalRoomExit`: no Foundry test harness exists for `dungeon-scene.mjs`
  (same boundary as every other function there) — verify via live
  verification and an explicit hand-trace instead (same fallback pattern
  Task 2 already established): confirm the flagged enclosure wall is found
  and deleted, confirm the replacement frontier-placeholder wall carries the
  same flag/coordinates a normal non-goal room's would, and confirm the
  existing (untouched) supersede-on-next-build logic then correctly
  replaces it once the chain is extended past that slot.

## Out of scope

- Fixing the first-room-should-always-be-Narrative-and-not-count-toward-size
  gap (recorded as background project knowledge; a separate concern from
  precalculating whatever the sequence generator actually produces).
- Measuring or optimizing the actual cost of building 10-20 rooms in one
  pass instead of across many door-opens (flagged as a genuine unknown, not
  addressed here — if it turns out to matter in practice, worth its own
  follow-up).
- Extending eager precalculation to GM-present runs (the issue scopes this
  to GM-less mode only; left as an explicit future option, not decided
  here).
