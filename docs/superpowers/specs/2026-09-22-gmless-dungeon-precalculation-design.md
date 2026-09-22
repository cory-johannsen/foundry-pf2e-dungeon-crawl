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
a given already-built slot. Confirmed separately: `applySequenceMutation`
already refuses to mutate the goal room (`if (!next || next.isGoal) return
rooms`, `dungeon-deck.mjs:312`), so the one room whose geometry is genuinely
special (`hasOutgoing: false`) can never be a mutation's target — the
kind-independence claim above holds at the one place it would matter most.

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

## Architecture

**Already implemented (Tasks 1-2, commits `791c8fc`/`af80e24`/`0da6900` on
branch `worktree-agent-aa5921258df7bf67c`, passed their own task reviews):**
a pure `roomsToEagerlyBuild(state)` in `dungeon-runner.mjs` returns
`{room, physicalSlot}` pairs for every room the GM-less path should build
(every room except an index-1 combat room), and `startDungeonRun`
(`dungeon-app.mjs`) branches on `state.hostUserId` — GM-hosted keeps the
original single-room build, GM-less loops `buildPopulateAndUnlockRoom` over
that list. This part is correct and does not change.

**New work this revision adds (not yet implemented):**

1. `buildPopulateAndUnlockRoom(scene, state, room, physicalSlot, { unlock = true } = {})`
   gains the `unlock` option described above. The GM-less eager loop passes
   `unlock: physicalSlot === 1`.
2. One teardown function per content type, each living next to its
   `ensure*`/`populate*` counterpart: something like
   `clearSlotEncounter(scene, physicalSlot)`,
   `clearSlotTrap(scene, physicalSlot)`, `clearPuzzleState(sceneId, roomId)`,
   `clearSkillChallengeState(sceneId, roomId)`, `clearNarrativeState(sceneId, roomId)`
   — exact names/signatures are an implementation-time decision, not fixed
   here; each just needs to undo exactly what its counterpart does (delete
   spawned tokens/actors, or delete the room-keyed setting entry).
3. A re-sync function, called from `markRoomOutcome` (`dungeon-runner.mjs:177`)
   immediately after `applySequenceMutation` runs, only when
   `state.hostUserId` is set: for `remove_next`, tear down and re-populate
   every already-built slot from the mutation point to the old tail, then
   tear down the now-orphaned trailing slot; for `insert_after`, tear down
   and re-populate the same range, then call `buildPopulateAndUnlockRoom`
   once more to physically extend the chain by one slot. Neither case calls
   `buildRoomAtSlot` for any slot whose room didn't change identity —
   re-populating in place is enough there, no need to tear down walls that
   are already correct for that slot number.

`applySequenceMutation` itself, `buildRoomAtSlot`/`buildConnectionGeometry`
and the rest of `dungeon-layout.mjs`, and the relay fallback
(`dungeon-remote.mjs`) are all untouched — this design deliberately adds a
reconciliation step around the existing mutation/geometry code rather than
changing either.

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
