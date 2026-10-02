# #585 Dead-edge walls and Turn back at any dead end (design)

Follow-up to #427 Chunk 7 (stubs) and #439 (retreat). User decision (final):

1. A dead edge (union oracle: truth OR walkability dead) that cannot become a stub gets NO door and NO corridor: the
   source's face stays a solid wall where the door would have been, and the edge leaves `state.edges` (like a stub), so
   progression never offers it.
2. `Turn back` is offered whenever the current room has no walkable forward exit, not only after a stub door was
   opened. Decision 10 ("no leak") is kept for stub doors. A room that resolves with no way forward says so in one line.

New runs only (layoutVersion >= 3). v1/v2 stay byte-identical.

## Measurements (500 seeds, shipped pipeline = `chooseRunLayout`, reseed N = 20, retreat on)

Static, before building: every dead edge that is still live after the stub plan would be walled.

| metric | value |
| --- | --- |
| dead edges walled | 495 (0.99 per dungeon; 135 of 500 dungeons have one; max 14) |
| stubs | 1466 |
| mean exits per reachable non-goal room | 1.216 doors before, 1.000 live forward after (1.168 counting stub doors) |
| reachable rooms with no forward exit and no stub (pure walled dead end) | 77 of 6478 |
| reachable rooms with only stubs (retreat after stub opened) | 1068 |
| rooms newly orphaned by walling | 0 (a dead edge is already impassable under the union oracle) |
| rooms already physically unreachable | 463 of 7441 (6.2%); kinds: combat 181, treasure 83, skill_challenge 73, puzzle 48, trap 45, narrative 33 |
| dungeons with a dead door into an already-unreachable branch | 130 (291 doors) |
| careless walker: retreats per walk, stuck | 2.24, 0 |

Without reseed (raw seeds) 53% of dungeons lose the goal under the union oracle; the reseed (N = 20) removes that, so the
product numbers are the table above. Walling removes no reachable room, so the 25% stop threshold is not approached.

## Design

* Run state: `walledEdges: { [sourceId]: [targetId] }` and `deadEdgeWalls: true` (both only when layoutVersion >= 3 and
  the plan ran). `edges` excludes walled edges (as it excludes stubs); `layoutEdges` keeps them (no room moves, an
  orphaned room still gets built and keeps its walls). A run without `deadEdgeWalls` behaves exactly as before.
* Layout: `incomingConnectionsFor`, `incomingSlotsV3`, `pendingForeignMarginOpenings`, `plannedMarginOpenings`,
  `layoutEdgeGeometry`, `planStubGeometries` and the scene builders treat a walled edge as excluded (no incoming slot, no
  corridor, no foreign margin opening, no outgoing door slot because it is not in the source's `edges`). The source's
  south/east face is therefore the plain enclosure wall: a solid wall exactly covering the former door span, nothing leaks.
* Planner (`planStubsVerified`): after the stub plan, iterate to a fixpoint: build the scene, take the union dead real
  edges of the current graph, wall them (remove from `edges`), rebuild. Walling removes doors, which re-slots siblings and
  can kill a different edge; the loop reruns until no live real edge is dead. Each pass walls at least one edge, so it ends.
  The verdict returned to the reseed predicate is that of the final scene (goal flooding the union live graph).
* Retreat: `canRetreat` already refuses only for an undiscovered stub, so a room with no forward edge and no stub offers
  Turn back once judged. New: `announceRetreatIfAvailable` also runs when a room resolves into such a dead end, with the
  flavor line `PF2EDC.Dungeon.Retreat.NoWayForward` ("There is no way forward here."), gated by `state.deadEdgeWalls`.
  The tracker button (`retreatUiFor`) already follows `canRetreat`.
* `retreatVersion` stays 1 (reducers and `canRetreat` semantics are unchanged); the persisted `deadEdgeWalls` flag gates
  the new announce/flavor and the new builds, so an existing v3 run created before this change keeps the old behavior.
