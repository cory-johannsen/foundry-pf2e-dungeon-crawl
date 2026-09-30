# Follower Marching Order — Design

Tracks #181.

## Problem

`aiControlledActorIds` (`scripts/dungeon-runner.mjs`'s `computeAiControlledActorIds`)
is whichever party members' owning players are currently offline, in whatever
order `game.actors.party.members` happens to produce — not a deliberate
sequence. `moveFollowersToward` (`scripts/dungeon-follow.mjs`) processes
followers in that same incidental order, and `findFollowMove`/`freeCellsNear`
(`scripts/dungeon-follow-mechanics.mjs`) picks each follower's own closest
free cell *near the leader*, with no concept of formation, priority, or
queuing.

This has two observed consequences:

1. **Non-deterministic starvation** (#87): when the leader has fewer valid
   adjacent cells than there are followers (a corner, a doorway), *which*
   follower ends up stranded with `"no-route"` is essentially random from
   session to session.
2. **Narrow-corridor pileup** (live-reproduced this session, 2026-09-30):
   in a 1-cell-wide hallway, only the follower closest to the leader can
   ever find a reachable cell "near the leader" — every other follower's
   own candidate search requires a path through the cell the closer
   follower already occupies, which is impossible in a single-file
   passage. Repeated follow-cycles leave the trailing followers jittering
   in place a few cells back, never catching up, because the search is
   always anchored at the leader rather than at whoever is immediately
   ahead in line.

Pure priority/ordering (who wins a tie for a scarce cell) fixes (1) but not
(2) — (2) needs each follower to target a *different* reference point, not
just to be tried in a more predictable order.

## Scope

**GM-less (player-led) runs only.** Follow-the-leader itself is only active
when `hostUserId` is set, which only happens for a player-initiated run
(`scripts/dungeon-follow.mjs`'s `resolveLeaderToken` returns `null`
immediately otherwise, per this module's own
`docs/superpowers/specs/2026-09-21-offline-player-ai-control-design.md`).
A GM-hosted run has no leader concept at all today, and inventing one is
out of scope here — marching order has nothing to attach to in that case,
so the feature is inert there, same as follow-the-leader already is.

Out of scope: any UI/algorithm change for GM-hosted runs; renaming or
restructuring `aiControlledActorIds` itself; combat movement (marching
order only affects `dungeon-follow.mjs`'s between-fights following, not
`dungeon-combat.mjs`).

## Data model

Add `marchingOrder: [actorId, ...]` as a new field on the same per-scene
run-state object `aiControlledActorIds`/`hostUserId` already live on
(`dungeon-runner.mjs`'s `createRun`/`getRunState`/`persist`). This object
backs the world-scoped `dungeonRuns` Foundry setting
(`game.settings.register(MODULE_ID, "dungeonRuns", {scope: "world", ...})`),
so `marchingOrder` persists across reloads for free via the existing
machinery — no new storage mechanism.

- **Initialization**: at run start, `marchingOrder` is set to a copy of
  `aiControlledActorIds` in its current (arbitrary) order — no forced setup
  step before a run can begin.
- **Reconciliation**: `aiControlledActorIds` is designed to be able to
  change mid-run (a player going offline/online) — though as of this
  writing `dungeon-runner.mjs` only ever computes it once, in `createRun`
  (final review, 2026-09-30: confirmed by grep, no other writer exists
  today), so this reconciliation currently only matters for a run whose
  stored state predates this feature and therefore has no `marchingOrder`
  field at all. It's kept as designed rather than trimmed to today's
  reality, since it's what makes an old run self-heal for free and costs
  nothing to run every cycle. Rather than trying to keep the stored
  `marchingOrder` perfectly in sync at every write site, `moveFollowersToward`
  computes the *effective* order fresh each cycle: filter the stored
  `marchingOrder` down to actors still present in the current
  `aiControlledActorIds`, then append any `aiControlledActorIds` member
  missing from that filtered list (newly-offline players default to lowest
  priority) at the end. This is cheap, run every cycle, and makes the
  stored value self-healing — a stale or even manually-corrupted
  `marchingOrder` can never crash or silently drop a follower.
- **Setter**: `setMarchingOrder(sceneId, orderedActorIds)`
  (`dungeon-runner.mjs`, mirroring the existing single-field mutator
  pattern, e.g. `setObjective`) validates `orderedActorIds` is a
  permutation of the current `aiControlledActorIds` (same length, no
  duplicates, every id present) before persisting; throws otherwise so a
  caller bug surfaces immediately instead of corrupting run state.

## Algorithm — chain-following

`moveFollowersToward` already loops through follower actor ids
sequentially, accumulating claimed cells as it goes
(`occupied.push(...)` after each successful move) — chain-following is a
small, targeted change to what each iteration searches near, not a
restructuring of the loop:

- The loop iterates the *effective* marching order (reconciled per above)
  instead of the raw `aiControlledActorIds` array.
- The first follower in that order targets the leader, exactly as today:
  `findFollowMove(fromCell, leaderCell, occupied, isBlocked, bounds, footprint)`.
- Every follower after the first targets whoever is immediately ahead of
  it in the order, using that predecessor's *current* cell at the moment
  of the call: `findFollowMove(fromCell, precedingFollowerCell, ...)`.
  Because the loop is sequential and each follower's own position/occupancy
  update happens before the next iteration reads it, "current cell"
  already reflects the predecessor's own move from earlier in this same
  cycle — the chain is responsive within a single follow-cycle, not lagged
  by one full cycle per link.
- `findFollowMove` itself needs no signature or behavior change — it
  already accepts an arbitrary target cell; chain-following only changes
  which token's cell gets passed in.
- If a predecessor doesn't move this cycle (`"no-route"`), the follower
  behind it simply targets wherever the predecessor currently sits — the
  whole chain naturally queues up behind a blockage rather than erroring,
  skipping, or needing special-case handling.
- Footprint-aware occupancy (#140) is unaffected: `occupied`/
  `occupiedFootprints` already includes every token's own footprint,
  including followers processed earlier in the same cycle, so a
  chain-following follower correctly avoids overlapping a larger
  predecessor's own body.

## UI

A new section in `DungeonApp`'s template (`templates/dungeon-tracker.hbs`),
visible only when a run is active and the current user is either the
leader (`hostUserId` match) or the GM — matching the issue's own "leader
(or GM)" framing and this app's existing `isGM` direct-call /
`requestDungeonAction` relay split used for every other non-GM-originated
action in this app.

- Lists the currently AI-controlled followers (actor name) in marching-order
  sequence, driven by the same reconciled effective order the algorithm
  uses — a follower who comes back online drops off the list automatically,
  no separate display state to keep in sync.
- Each row has up/down arrow buttons (disabled on the first row's "up" and
  the last row's "down") wired via this app's existing
  `static DEFAULT_OPTIONS.actions` `data-action` map
  (`moveMarchingOrderUp`/`moveMarchingOrderDown`).
- A click computes the new order client-side, calls `setMarchingOrder`
  (direct if GM, relayed via `requestDungeonAction` if the leader is a
  non-GM player — the established #65 pattern), and the app re-renders.

## Testing

- **Reconciliation**: a newly-AI-controlled actor gets appended to the
  effective order; a no-longer-AI-controlled actor is filtered out;
  relative order of the rest is preserved. Pure-function tests, no Foundry
  stubs needed.
- **Chain-following (the actual regression test for the live-observed
  bug)**: extend `dungeon-follow.test.mjs`'s existing fixtures
  (`makeToken`/`makeScene`/`installFoundryStubs`, already used by
  `moveFollowersToward`'s own tests) with a narrow 1-wide corridor and 3+
  AI-controlled followers in a given marching order; assert they end up
  queued single-file in that order across a couple of follow-cycles,
  rather than clustered/stuck behind the first one.
- **Setter validation**: `setMarchingOrder` rejects a list that isn't a
  permutation of the current `aiControlledActorIds` (wrong length,
  duplicate, unknown actor id).
- **UI stays thin, untested at the rendering level**: action handlers only
  compute the new order and call the (fully tested) setter/reconciliation
  functions, matching how this codebase already draws the line between
  tested pure logic and untested Foundry-glue rendering (no existing test
  in this repo renders an actual Handlebars template).
- **Trivial cases**: zero or one AI-controlled follower needs no
  special-casing — the loop just has zero or one link.

## Success criteria

- In the exact live-reproduced scenario (leader in a 1-wide corridor, 4
  AI-controlled followers), all four followers make progress each
  follow-cycle instead of only the closest one.
- The leader (or GM) can view and reorder the current AI-controlled
  followers from the DungeonApp tracker at any point during a GM-less run.
- Reordering survives a reload (world-scoped setting).
- No change in behavior for a GM-hosted run (feature is inert there, same
  as follow-the-leader already is).
