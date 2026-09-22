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

Precalculate the base sequence only; leave sequence mutations exactly as
they are today (confirmed with Cory — narrows the live-GM dependency window
down to just mutation-inserted rooms, rather than eliminating it entirely).
Keep the first-room combat deferral unchanged for GM-less runs too (confirmed
with Cory) — this design does not change which rooms get built eagerly
beyond extending "how many," and does not touch room-kind assignment.

No new "GM-less mode" flag: reuse the existing `hostUserId` signal.
`startDungeonRun` already runs on whichever client creates the run, so
detection is `!game.users.get(hostUserId)?.isGM` at that exact point — a
GM-hosted run keeps today's behavior unchanged; a non-GM-hosted run
(the real GM-less case, where the privileged work happens via relay or an
Agent-GM account) gets the base sequence built eagerly. (This exact
expression — where `hostUserId` is actually set/read relative to
`startDungeonRun`'s own call site, and whether `game.users.get` is the right
lookup at that point — is based on this investigation's read of
`dungeon-runner.mjs`/`dungeon-remote.mjs`, not independently re-verified
line-by-line; the implementation plan should confirm the exact shape against
current code before writing it.)

## Architecture

`startDungeonRun` (`dungeon-app.mjs:353`) currently builds only
`state.rooms[1]` (room 0 is the party's starting room) before activating the
scene. Change the build step to branch on host GM-ness:

```js
if (hostIsGm) {
  // existing behavior, unchanged
  if (firstRealRoom && firstRealRoom.kind !== "combat") {
    await buildPopulateAndUnlockRoom(scene, state, firstRealRoom, 1);
  }
} else {
  // GM-less: eagerly build every room in the base sequence except a
  // combat-kind room at index 1, which keeps the existing manual-button
  // deferral regardless of host
  for (let i = 1; i < state.rooms.length; i += 1) {
    const room = state.rooms[i];
    if (i === 1 && room.kind === "combat") continue;
    await buildPopulateAndUnlockRoom(scene, state, room, i);
  }
}
```

No new build mechanism — the same idempotent, already-guarded call this
module uses for every room today, just invoked more times up front. Scene
resizing (`ensureSceneCovers`) already runs per-room and handles being
called in a tight loop the same way it handles being called across many
separate door-opens; no batching/precomputed-final-size optimization is
introduced here, to keep this change minimal.

`applySequenceMutation`/`markRoomOutcome` and the relay fallback
(`dungeon-remote.mjs`) are untouched — a mutation-inserted room still builds
lazily, still via relay if no privileged client is live at that moment,
exactly as today.

## Data flow

- **GM-hosted run:** unchanged — room 0 placed, room 1 built if non-combat,
  every subsequent room built one-ahead as outcomes resolve.
- **GM-less-hosted run:** room 0 placed, then every room in the base
  sequence (except an index-1 combat room) built immediately in one pass at
  `startDungeonRun`. From then on, walking room to room needs no live
  privileged client at all — until a Reward/Ruin mutation inserts a new
  room, which still needs one (relay-covered, same as today).

## Error handling

No new failure modes: each `buildPopulateAndUnlockRoom` call in the new loop
is the same already-guarded call already used elsewhere, so a partial
failure partway through the loop (e.g. Foundry API hiccup on room 7 of 12)
leaves rooms 1-6 correctly built and rooms 7+ in the same "not yet built"
state a normal lazy run would have them in — no special rollback needed,
since a later manual "Populate Next Room" press or the existing one-ahead
build path can still pick up wherever the loop stopped.

## Testing

- Unit test `startDungeonRun`'s new branch: a GM host builds only room 1
  (existing coverage, must not regress); a non-GM host builds every room in
  `state.rooms` except an index-1 combat room, in order.
- A non-GM host with a combat-kind room at index 1 still leaves it unbuilt,
  matching the GM-hosted case's existing exception.
- A non-GM host with a combat-kind room at some OTHER index (not 1) still
  builds it eagerly — the exception is index-1-only, not "any combat room."

## Out of scope

- Removing the live-GM dependency for mutation-inserted rooms (would require
  either disabling mutations for GM-less runs or speculatively
  pre-building both branches at each mutation-capable point — rejected;
  Cory chose to keep mutations and accept the narrower dependency window).
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
