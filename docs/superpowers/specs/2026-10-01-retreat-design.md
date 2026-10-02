# Retreat — a way back to the last fork — design

**Tracks:** [#439](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/439)
(spun out of #427, decision Q9 / Decision 9 of
`2026-10-01-boxed-in-corridor-routing-design.md`).

**Status:** design, 2026-10-01. Spec only: no plan, no code. The user was not
in the session; every product choice below is a recommendation, and the ones
that need a human decision are collected in "Open product questions" (the
spec is written so the recommended answer is the default if nobody answers).

## Problem

The run only moves forward. `advanceToRoom` accepts a room only if it is in
`state.edges[state.currentRoomId]`, and the only way back is
`undoLastRoomEntry`, which is refused once the entered room is judged
(`canUndoRoomEntry`). #427's dead-end stub (a door to a short rubble-capped
corridor, locked like a normal door, no extra check, Decision 10) is
therefore safe only for a source room that keeps another forward edge. The
500-seed sweep says 1,952 of the 2,470 unroutable edges (79%) are the
source's ONLY forward edge. Stubbing one of those today would leave a party
standing in a judged room with no way on: a soft-lock.

Retreat is the missing piece: from a room with no unspent way forward, the
party can turn back to the nearest earlier room on its own path that still
has one. It makes the stub applicable to sole-child sources (#427 Chunk 7)
and is also the general answer to any dead end.

### Goals

1. A party can never be left with no forward move and no retreat (proved
   structurally, checked by a property test over 500 seeds).
2. The stub door stays indistinguishable from a real door (Decision 10):
   retreat is not offered, and the tracker does not hint at it, until the
   party has actually discovered the dead end.
3. Retreat is a cheap, deterministic state change plus a token teleport,
   built on the machinery `undoRoomEntry` already uses (and the same
   permission/relay path), not a new traversal system.
4. v3 runs only. Existing runs, and v1/v2 runs, never see the feature.

### Non-goals

- Walking the party back through the corridors (the tokens are teleported,
  like undo; no animation through walls, no follow-the-leader on the way).
- Re-running or undoing anything about a judged room (nothing is refunded,
  rewards and XP already granted stay granted).
- Letting the party retreat out of an unjudged room (that is Undo's job,
  unchanged) or out of a room that still has a forward move (no "flee
  anywhere" button; see Q3).
- A general "fast travel" or map-jump feature.

## Measurements (500-seed sweep)

Throwaway script over `tests/helpers/layout-sweep.mjs` (`planSelector`,
layoutVersion 2 plan, `findCorridorPath` for "null edge", real non-hidden
edges only; script not committed). Reproduces #427's classes: 8,911 real
edges, 1,966 of them null (1,952 sole-child plus 14 non-sole, matching the
spec's 1,952 / 14), 7,994 rooms.

Stub eligibility, greedy in canonical order (target id, source id), hard
rules 1 (target keeps a routable non-stub parent) and 3 (every room reachable
and the goal reachable from `room-entry` over non-stub edges) in both
columns; only rule 2 (source keeps another forward way) differs:

| Rule set | Real null edges stubbed | Dungeons with at least one stub |
| --- | --- | --- |
| today (rule 2 enforced) | 0 of 1,966 | 0 of 500 |
| with retreat (rule 2 replaced by retreat) | 1,544 of 1,966 (78.5%), all sole-child | 484 of 500 |

The 14 non-sole real edges fail rule 1 or reachability in this simplified
greedy order (the real `planStubs` may place a few of them); #427's own
"about 464" is the 450 hidden shortcut edges plus those 14, and none of it
depends on retreat. Counting those, retreat takes #427's
stub-eligible set from about 464 of 2,470 (19%) to about 2,000 (81%). The
remaining ~420 real null edges stay on the direct-line residual because
stubbing them would orphan their target or the goal (rule 1/3), which no
retreat can fix. Every one of the 1,544 stubbed sources becomes a "dead-end
room" (a judged room whose only forward edge is a stub): 1,544 of 7,994
rooms (19%).

How often a party realistically meets one. 40 seeded random walks per
dungeon (20,000 walks), the party picks uniformly among doors it has not
already used: unvisited real children and unopened stub doors (a stub door
looks like a real door). On reaching a dead end it retreats (rule below):

| Measure | Value |
| --- | --- |
| walks that open at least one stub door | 13,813 of 20,000 (69%) |
| walks that never retreat | 6,187 (31%) |
| retreats per run | mean 1.42; 1: 5,746, 2: 4,125, 3: 2,182, 4: 1,068, 5: 535, 6: 144, 7: 13 |
| rooms backed up per retreat | mean 1.7 |
| walks that fail to reach the goal | 0 |
| walks that end with no forward move AND no retreat | 0 |

A "careless" party that also re-opens doors into rooms it has already
cleared (merge rooms it can reach from another parent) averages 2.49
revisits and 2.90 retreats per run and still never gets stuck. So: a
typical run meets one or two dead ends, a few meet five or more. The
product consequence is real (see Q1, Q2) and is the reason retreat must be
cheap and the dead end must feel intended, not punitive.

## Terms

- **Spent child:** a child room already visited: it is in `state.history`
  (judged) or on the party's current `retreatPath`. Re-entering one is a
  revisit, never a first entry.
- **Open child:** a real, non-stub child (`state.edges[room]`, which already
  includes a revealed hidden shortcut and excludes stubs) that is not spent.
- **Dead-end room:** the current room is judged (it is in `history`), is not
  the goal, and has no open child. Because stub doors are not in
  `state.edges`, this is exactly "the only forward edge is a stub" (or every
  forward child is spent, which only retreat itself can cause).
- **Fork:** an ancestor on `retreatPath` that has at least one open child.
- **Retreat target:** the nearest fork, scanning `retreatPath` backwards from
  the room before the current one.

## Design

### Recommendation among approaches

1. **State-synced manual retreat with a teleport (recommended).** A
   `retreat` action moves `currentRoomId` to the retreat target, truncates
   the path, and teleports the party tokens, exactly like Undo does. It
   needs one new run-state field (the path), one new pure module, and one
   button in two places. Chosen.
2. Auto-detect physical backtracking (token crosses a door or enters a fork
   room, the module infers the retreat). Rejected: the party can wander,
   AI followers drift (#87/#141 history), and `currentRoomId` must be an
   unambiguous fact because `handleDungeonDoorOpened` and the tracker key
   off it.
3. Make the dead-end room itself reopen a path ("the rubble gives way").
   Rejected: that is a second hidden edge, defeats the stub (the dead end
   would not be one), and changes #93's guarantees.

### Where retreat is offered

Never before the dead end is discovered.

- **Discovery.** When the stub door is opened (a wall flagged
  `dungeonStubDoorFor`, #427, which `handleDungeonDoorOpened` otherwise
  ignores), the GM client records `stubsOpened[source->target] = true`
  (once, idempotent) and posts the rubble flavor line from #427. If the
  room is now a dead-end room AND every stub door of that room has been
  opened, it also posts a chat card "The way is choked with rubble. Turn
  back to {fork room name}?" with a `Turn back` button.
- **Tracker.** `DungeonApp` adds a `Turn back` button (a new footer next to
  the existing Undo footer in `templates/dungeon-tracker.hbs`) whenever
  `canRetreat(state)` is true. `canRetreat` is the pure predicate in the
  next section and includes the "all stubs opened" condition, so the
  button never appears before discovery.
- **Chat card:** same pattern as the treasure claim card (a message whose
  button calls a `sceneId`-parametrized function, non-GM routed through
  `requestDungeonAction`).
- **Who may press it:** whoever may act on the dungeon
  (`canActOnDungeon`: GM, or the hosting non-GM, #109). A non-GM host's
  request travels the existing relay (`DUNGEON_ACTIONS.retreat` in
  `scripts/dungeon-remote.mjs`, next to `undoRoomEntry`). Other players
  see the chat card but the button is inert for them (same as every other
  tracker button).

No door-level "retreat" affordance is added: doors map to edges, and retreat
is not an edge.

### What it moves

`retreatToFork(sceneId)` in `scripts/dungeon-scene.mjs` (the Foundry-facing
half, modelled on `undoRoomEntry`):

1. Precondition check (below). On failure: warn, return.
2. Compute the target from `canRetreat`/`retreatTargetFor` (pure).
3. Teleport the party tokens (`partyActorIds()`, same selection undo uses)
   with `moveTokensToRoom(scene, tokenIds, targetRoomId, rank, col, seed)`,
   ordered by `effectiveMarchingOrder(state)` with humans first, so the
   single-file order is preserved in the arrival room. Use a
   `{ teleport: true }` update (see the #87 fix; plain `updateEmbeddedDocuments`
   is the undo path today and the plan must confirm it does not get
   wall-constrained, same risk #87 documented).
4. `focusCameraOnRoom(scene, targetRoomId, rank, col, seed)`.
5. Persist via `retreatTo` (runner, below).
6. Post a chat line "The party turns back to {target name}."

Not touched: doors. Every door the party opened stays open. The doors out of
the fork were already unlocked when the fork was judged, so the other
children's doors are ready (and `unlockDoorsFromRoom` must NOT be re-run:
it sets `CLOSED` unconditionally and would re-close doors the party opened,
the #152 hazard). Tokens revealed in the abandoned branch stay revealed
(they are judged; hiding them again is Undo's job and Undo does not apply).
Marching order and `aiControlledActorIds` are untouched (they are actor ids,
not positions); AI followers are teleported with the party, not asked to
walk (they would path through the whole branch).

### Run state

Added by `createRun` for layoutVersion >= 3 only; absent on every older run.

| Field | Shape | Meaning |
| --- | --- | --- |
| `retreatVersion` | number, `1` | Capability marker. Absent or 0 = retreat does not exist for this run. THIS is what #427 Chunk 7 reads (see "Interface to #427"). |
| `retreatPath` | `string[]`, starts `['room-entry']` | The rooms from entry to `currentRoomId` along the party's actual route, current room last. Pushed on every entry (including a revisit), popped by Undo, truncated by retreat. |
| `stubsOpened` | `{ [`${sourceId}->${targetId}`]: true }` | Which stub doors the party has opened (discovery). Written by the stub-door handler. |
| `retreats` | `{ fromRoomId, toRoomId, at }[]` | Append-only log (for the tracker history, tests and #370-style diagnostics). |

`history` stays what it is: one entry per JUDGED room, used for the room
counter (`roomNumber`) and the duplicate-resolve guard. A retreat does not
write `history` (it is not a judgement) and does not change
`roomNumber`: a revisited room is already in `history`, so it counts once.
`lastAutoEntry` is set to `null` by a retreat and by a revisit (Undo applies
only to a first entry).

"Visited" is derived (`history` rooms plus `retreatPath` rooms), not stored,
so it cannot drift from the two sources of truth that already exist.

Pure functions (new module `scripts/dungeon-retreat.mjs`, no Foundry
imports, mirrors `dungeon-deck.mjs`'s style; the runner and the scene call
it):

```
RETREAT_VERSION = 1
spentRooms(state)             -> Set<roomId>   // history rooms + retreatPath rooms
openChildren(state, roomId)   -> roomId[]      // state.edges[roomId] minus spentRooms
isDeadEnd(state)              -> boolean       // see Terms
retreatTargetFor(state)       -> roomId | null // nearest fork on retreatPath, from length-2 down to 0
canRetreat(state, { combatActive }) -> { ok, targetId?, reason? }
```

`canRetreat` returns `ok` only when ALL hold: `state.retreatVersion >= 1`;
`!state.completed`; the current room is judged (in `history`); no combat is
active on the scene (the caller passes it in; the pure function does not
read `game`); `isDeadEnd(state)`; every stub door of the current room has
been opened (`stubsOpened`, using `state.stubEdges[current]`); a target
exists. `reason` is one of `disabled`, `completed`, `unjudged`,
`combat`, `not-dead-end`, `undiscovered`, `no-target` (the last is a
never-should-happen guard, see "Soft-lock proof").

Runner (`scripts/dungeon-runner.mjs`):

- `advanceToRoom` also appends the room to `retreatPath` (when
  `retreatVersion >= 1`). A revisit (target is already spent) is accepted by
  the existing `edges` check, additionally sets `lastAutoEntry: null`.
- `undoLastRoomEntry` pops `retreatPath` (only a first entry is undoable,
  and `canUndoRoomEntry` already refuses once the room is judged).
- `retreatTo({ sceneId })`: re-checks `canRetreat` from the stored state
  (last-writer-wins settings; see "Multiplayer"), sets `currentRoomId` to
  the target, `retreatPath = retreatPath.slice(0, indexOf(target) + 1)`,
  `lastAutoEntry: null`, appends to `retreats`, persists. Returns
  `{ ok, state, fromRoomId, toRoomId }`.
- `markStubOpened({ sceneId, sourceId, targetId })`: idempotent write.

### Interaction with the existing door handler

`handleDungeonDoorOpened` today (a) ignores anything but a reveal door,
(b) requires the target to be in `edges[currentRoomId]`, (c) reveals
tokens, (d) starts combat for a combat room, (e) advances, (f) for a rest
room resolves it and unlocks its children. After a retreat the party can
re-open a door into a room it has already cleared (a merge room reached
from a second parent, or a door out of the fork back into the spent branch).
Today that would start the room's combat AGAIN. So a **revisit branch** is
required, keyed on the target already being spent: no `revealSlotTokens`, no
`startCombatForRoom`, no rest-room auto-resolve/unlock, only
`advanceToRoom` (which pushes the path, `lastAutoEntry: null`) and the
camera. This guard is needed by retreat alone (no other feature creates
revisits), so it ships in the same chunk as retreat and is covered by a
test that re-opening a judged combat room starts no combat.

A second handler branch for the stub door (`dungeonStubDoorFor`, #427): call
`markStubOpened`, post the flavor line, post the retreat card when it
applies; never `advanceToRoom`.

### Spent branches and re-locking

v1 does NOT re-lock doors into spent branches. A dead branch behind the
fork is still reachable, as a revisit: the party wastes a door and a
retreat, never an encounter (the careless-party row above: 2.49 revisits and
2.90 retreats per run vs. 1.42 for a party that only takes new doors).
Re-locking (`spent(c)` = visited and no open room reachable from c over
non-stub edges; call the existing `relockDoorFromRoom` for each such edge,
and filter spent targets out of `unlockDoorsFromRoom`'s `childIds` in
`resolveCurrentRoom`) is designed as an optional later chunk (R5) and is
Q5. The soft-lock proof does not depend on it.

### Soft-lock proof

Claim: for every v3 plan that satisfies #427's rules 1 and 3, every
reachable run state with `completed = false` has either an open child
(a forward move) or a retreat target.

Definitions: `P` = `retreatPath` (a chain from `room-entry` to the current
room `c`); `S` = spent rooms. Invariant I1: every room in `S` but not in
`P` has no open child (it was popped by a retreat that chose the NEAREST
fork, so every popped room on `P` after the target had none; a room's
child set only grows by a hidden-path reveal, which happens only while the
party is judging that room, i.e. while it is on `P`; Undo only pops an
unjudged first entry).

Take `c` with no open child (otherwise a forward move exists). By rule 3
the goal `g` is reachable from `room-entry` over non-stub edges and
`g` is not spent (the run is not complete). Take any such path
`room-entry = p0 -> p1 -> ... -> pk = g` and the first `p(i+1)` not in `S`
(exists, `g` is not). `p(i)` is in `S` and has the open child `p(i+1)`,
so by I1 it is on `P`, hence a fork, and `retreatTargetFor` finds one at
the same position or nearer. The target is strictly before `c` on `P`
(`c` has no open child, so `c != p(i)`), so `P` strictly shrinks and the
walk is finite (each retreat shortens `P`; each forward move spends a
room, and rooms are finite, so no cycle). QED. Note this proof is why a
retreat targets the nearest fork on THE PATH rather than "any room with an
open child": it makes I1 hold.

What the proof needs from #427: rule 3 only (goal reachable over non-stub
edges). It does NOT need rule 2 and does not need "no non-goal room with
zero non-stub forward edges", which is exactly what Chunk 7 relaxes.

Failure modes the implementation must handle (each has a test):

- **`retreatPath` missing or inconsistent** (state written by another
  client, a hand edit, a crash between two persists): `canRetreat` is
  `disabled` and the tracker button shows a GM-only "Reset retreat path"
  that rebuilds `retreatPath` as `[room-entry, ...history rooms in order, current]`
  filtered to a valid chain over `layoutEdges`; the run is never blocked on
  the feature failing. Q6.
- **GM override as a last resort:** a GM-only "Move party to room..." is NOT
  added (that is a different feature); the existing Abandon remains the
  escape hatch.
- **Retreat refused with combat active:** warn, no state change.
- **Double click:** `retreatTo` re-reads state and re-checks `canRetreat`;
  the second call sees `currentRoomId` already moved and `not-dead-end` or
  `unjudged`, returns `ok: false`, no second teleport.
- **Teleport fails after the state write:** persist AFTER the token move
  (the reverse of what looks natural), so a failed move leaves the run in
  the dead end with the button still showing and nothing to repair.
  `resnapDriftedTokens` (reactive-only) covers a partial move.
- **Hidden-path reveal landed on a room later retreated from:** the revealed
  child is an open child of that room; I1 covers it.

### Interactions

- **Judged/resolved rooms.** Retreat requires the current room judged.
  Nothing about the judged rooms is undone, re-run or re-rewarded.
  `markRoomOutcome`'s duplicate guard (`history` contains the room) already
  makes a second judge of a revisited room a no-op, so a revisit cannot
  re-grant a reward or XP. The tracker for a revisited room shows
  `currentRoomResolved = true` already (it reads `history`).
- **Combat.** A dead-end room is judged, so its own combat is over. If a
  combat is active anywhere on the scene, retreat is refused (`combat`).
  A revisit never starts combat (see handler branch).
- **Completion and goal reachability.** `completed` is only set by judging
  the goal; retreat never touches it. A retreat never completes the run, and
  the proof guarantees the goal stays reachable. Goal room is never a
  dead end (`isDeadEnd` excludes it).
- **Hidden/secret doors.** A hidden shortcut whose stub is a "false
  shortcut" (#427 Decision 11) is opened from a room that still has real
  children, so it is not a dead end and retreat is not involved (opening it
  only calls `markStubOpened`). A hidden shortcut that WAS revealed adds a
  child to `state.edges`, so it is an open child and counts as a forward
  move; a hidden door that is still sealed is not in `edges` and never
  counts (a party cannot be "saved" by a door it has not found).
- **Marching order and AI/offline players.** Untouched order, teleported
  together. Retreat is a human/GM (or hosting player) action, never an AI
  decision: the combat-decision agent has no exploration decisions. A table
  where every player is offline AND the GM is the Agent login has nobody to
  press the button: Q4.
- **Multiplayer, GM-less hosting.** State lives in the `dungeonRuns` world
  setting; only the GM client executes scene effects, a hosting non-GM
  routes through `requestDungeonAction` exactly like `undoRoomEntry`, and the
  broadcast (`decideGmLessBroadcast`) delivers the new state. Two clients
  pressing at once: the second `retreatTo` re-reads and is rejected (above).
- **Layout version.** `retreatVersion` and `retreatPath` are written only by
  `createRun` for `layoutVersion >= 3`. A run without `retreatVersion` never
  shows the feature and never has a sole-child stub (Chunk 7 plans stubs
  only when it stamps `retreatVersion`). Existing runs are ignored, per the
  user's #427 decision.
- **Tracker counters.** `roomNumber`/`roomTotal` read `history`, so a
  retreat neither adds nor removes a counted room. A stubbed-away target is
  still counted in `roomTotal` (it is still reachable another way).
- **Chat/history.** A retreat adds a line to the chat; it is NOT added to the
  tracker's history list (that list is judgements).

### Cost of retreat (Decision 10 context)

Decision 10: the stub door itself has no extra check, roll or time cost.
Recommendation: the retreat has none either. No resource, no skill check, no
wandering encounter, no XP loss, no clock. Reasons: the party already paid
for the dead-end room (its encounter), the 69% / 1.4-per-run frequency means
any penalty is felt every run, and the module has no exploration clock to
charge (travel time is flavor only, `reduced_travel_time`/`extra_travel_time`).
Flavor carries the weight: the rubble line plus "the party turns back".
Whether to add any cost (e.g. a wandering-monster check, an in-fiction
time note, a rest-clock tick) is Q1.

## Interface to #427 Chunk 7 (sole-child stubs)

The exact thing Chunk 7 reads:

- **At precompute** (`scripts/ui/dungeon-app.mjs`, where `planStubs` is
  called): `retreatAvailable = (layoutVersion >= 3) && (RETREAT_VERSION >= 1)`,
  with `RETREAT_VERSION` imported from `scripts/dungeon-retreat.mjs`. Pass it
  to `planStubs({ ..., retreatAvailable })`. This is the existing parameter
  in the #427 plan (`retreatAvailable = false` by default).
- **In persisted run state:** `state.retreatVersion` (number). The planner
  stamped sole-child stubs only if it also stamps `retreatVersion: 1` in the
  same `createRun`, so `retreatVersion >= 1` is a precondition of any
  sole-child entry in `state.stubEdges`. A reader may assert it.
- **Rule 2 under retreat:** replaced by "the source may have no non-stub
  real child; the dead-end room is handled by `isDeadEnd` + `retreatTargetFor`".
  Rules 1 and 3 are unchanged, and rule 3's second half ("no non-goal
  room has zero non-stub forward edges") is dropped for sole-child sources
  only: the post-condition becomes the soft-lock claim above, checkable as a
  pure graph property (below).
- `planStubs` and retreat share no code; the only coupling is the flag
  and the rule-3 relaxation.

## Property tests and test plan

Pure (`tests/dungeon-retreat.test.mjs`, no Foundry):

- `retreatTargetFor` on hand-built DAGs: nearest fork, skips spent children,
  returns null when none, merge room whose other parent was already visited
  (the child is spent), hidden-path reveal makes a fork.
- `isDeadEnd`/`canRetreat` reasons table: each `reason` has a case.
- Runner: `advanceToRoom` pushes `retreatPath`, a revisit sets
  `lastAutoEntry: null`, `undoLastRoomEntry` pops, `retreatTo` truncates,
  logs, is idempotent under a double call, refuses a pre-v3 state and
  an unjudged room.

**Soft-lock property test** (`tests/dungeon-retreat-softlock.test.mjs`,
500 seeds via `buildSweepLayout`, using the stub set produced by the same
greedy as the measurement, later by `planStubs`): for each seed run a state
machine in which at EVERY step the checker asserts "a forward move exists or
`canRetreat` returns a target". Walks: (1) 40 seeded random walks per seed
with a sensible party, (2) the same with a careless party (revisits), (3) an
ADVERSARIAL walk that always takes an unopened stub door first and always
takes the stub-ward / dead-end-ward child first (worst-case ordering). Every
walk must reach the goal; no walk may reach a state with neither a forward
move nor a retreat; `retreatPath` must always be a valid chain from
`room-entry`; every retreat strictly shortens it. The proof makes the first
two redundant; they are the guard against a mistake in the proof's
invariant I1. Plus a structural per-seed check of the claim's premise:
goal reachable from `room-entry` over non-stub edges.

Scene (`tests/dungeon-scene.test.mjs` style, mocked scene):

- `retreatToFork` moves party tokens to the target room, ordered by marching
  order; persists AFTER the move; a thrown move leaves state unchanged.
- Handler: stub door open marks discovery, posts the card only at a dead
  end; opening a spent combat room starts no combat; a rest-room revisit
  does not re-unlock doors.
- Non-GM relay: `DUNGEON_ACTIONS.retreat` exists and calls the same function.

Live verification (manual, by the user): force a v3 run with a sole-child
stub (a fixture seed from the Chunk 7 residual set), open the stub door,
confirm the card, press `Turn back`, confirm tokens land in the fork room
with the camera, open the sibling door, finish the run.

## Phasing (PR-sized chunks)

| Chunk | Content | Risk |
| --- | --- | --- |
| R1 | `scripts/dungeon-retreat.mjs` pure functions + unit tests + the soft-lock property test (against the measurement's stub set). No runtime wiring, no flag. | low, pure |
| R2 | Run state (`retreatVersion`, `retreatPath`, `stubsOpened`, `retreats`) for layoutVersion >= 3 in `createRun`/precompute; `advanceToRoom`/`undoLastRoomEntry` maintain `retreatPath`; `retreatTo`, `markStubOpened`. | low-medium, touches progression |
| R3 | `handleDungeonDoorOpened`: revisit branch and stub-door branch; `retreatToFork` scene function; relay action. | medium, touches the door hook |
| R4 | Tracker button + template + lang strings + chat card. | low |
| R5 | Optional: re-lock spent branches (Q5). | medium |
| (#427 Chunk 7) | Sole-child stubs: `retreatAvailable` at precompute. Starts after R1-R4 are merged and the user live-verifies. | medium |

R1-R4 can merge before #427's stubs exist (v3 may not exist yet either:
R2's `retreatVersion` is written only when `layoutVersion >= 3`, a no-op
until then). Each PR bumps `module.json` per CLAUDE.md; R2-R3 also touch
`scripts/` import edges (`dungeon-retreat.mjs`), so run
`update-architecture-docs` in that PR.

## Risks

- **Frequency.** 69% of runs meet a dead end, 1.4 per run on average, up
  to 7. If dead ends feel like wasted time, the fix is a design one (cap
  the stub count per dungeon, or restrict sole-child stubs to rooms past a
  fork), decided in Chunk 7 with the real numbers, not here. Q2.
- **Revisits.** v1 allows walking into a spent branch (one wasted door
  and retreat). Cheap, but could annoy; R5 removes it.
- **Teleport semantics.** `moveTokensToRoom` is a plain update today; the
  #87 root cause was Foundry's wall-constrained `token.update`. The plan
  must verify the retreat move is `teleport: true` (a real risk if skipped:
  tokens stop at the first wall).
- **`handleDungeonDoorOpened` is the most delicate hook** (reentrancy
  guard, GM-only, camera). The revisit branch must not change the first-entry
  path byte for byte; tested.
- **Tracker staleness for non-GM clients** is by the existing broadcast; no
  new risk.

## Honest unknowns

- The 500-seed numbers use the sweep's real non-hidden edges and a greedy
  stub order; the real `planStubs` order and the 14 non-sole edges could
  shift 1,544 by a few percent. Ratchet the real value in Chunk 7.
- The party-behavior model (uniform among unused doors) is an assumption;
  real parties may peek into stubs less or more. The 69% figure is an
  upper-middle estimate, not an observation.
- Whether arrival placement ("top-left of the fork room", what undo does)
  is acceptable for retreat, where the party arrives from a corridor, is
  not tested live. A better placement (near the door they came back through)
  is a polish item, not blocking.
- No live test of AI-follower behavior right after a teleport (#87/#141
  history suggests it needs checking).
- Whether stubs/dead-ends interact with `roomsToEagerlyBuild` is covered by
  #427's own touchpoint list; retreat adds no build dependency.

## Open product questions

Defaults are the recommended answer; they apply if nobody answers.

- **Q1: Does retreat cost anything?** Default: no (see "Cost of retreat").
  Alternatives: a wandering-monster check, an in-fiction time tick, a
  one-time Perception/Survival check to find the way, a morale/stress note.
- **Q2: How often should a dead end happen?** Today's rule would stub 78% of
  sole-child null edges (about 3 per dungeon, 69% of runs). Default: accept
  that, decide a cap in Chunk 7 after live play. Alternative: cap at N per
  dungeon now.
- **Q3: Should the GM (or party) be able to turn back from a room that is NOT
  a dead end?** Default: no (Undo covers the unjudged case; a free
  anywhere-retreat undermines the branching choice). Alternative: a
  GM-only "Turn back" always available on a judged room.
- **Q4: Auto-retreat for tables with nobody to click?** (All players
  offline and an Agent GM, or a GM who wants no prompt.) Default: manual
  only. Alternative: a world setting `autoRetreat` (default off) so the
  GM client retreats right after the discovery card.
- **Q5: Re-lock spent branches?** Default: no in v1 (revisits are cheap
  and safe). Alternative: R5.
- **Q6: Repair control for a corrupt `retreatPath`?** Default: GM-only
  "Reset retreat path" in the tracker. Alternative: silent auto-rebuild on
  read.
- **Q7: Flavor text.** Default: the rubble line from #427 on opening, then
  "The way is choked with rubble. The party turns back." No collapse
  variant (Decision 12). Wording is the user's.
