# Topology-aware corridor routing (design note for #427 Chunk 1)

Status: design, 2026-10-01. Sibling of `2026-10-01-boxed-in-corridor-routing-design.md` (the spec; its
"Decisions" stay authoritative). Written after Chunk 1 PR B (#450) tripped kill criterion K2 and the user
chose "make the router topology-aware". Nothing here is implemented in `scripts/`; the only code is a
test-only prototype (`tests/helpers/topology-router.mjs`, `tests/helpers/lane-prototype.mjs`) that produced
the measurements below.

## 1. Why the lane plan alone failed (recap)

With each edge's cell path fixed by `findCorridorPath` (shortest, independent per edge), pinned door ends,
and only corner exit coordinates free, 204 of 2,063 multi-cell edges (9.9%) cannot be given non-crossing
lanes (allowance 41). 365 of the 381 pairs that cannot coexist even alone interleave across a 2-cell
stretch; only 16 are the cell-local north-south vs west-east kind. The cause is the choice of cell paths,
so the fix has to be in the router, not in lane offsets.

## 2. The topological model

A built edge is a path of cells c1..cn from the source room to the target room. Inside each cell the
corridor is a curve entering and leaving through points on the cell perimeter (a chord). A border between
two adjacent cells carries one crossing point per edge that uses it; borders are 13 units wide, so up to 13
one-wide lanes fit (measured peak load: 5, so capacity is never the issue).

**Shared stretch.** For two edges A and B, let S be a maximal 4-connected set of cells that both cross.
Restrict each edge to S: A becomes one or more sub-paths, each with two endpoints on the boundary of the
rectilinear region S (an endpoint is the border crossing where the edge enters or leaves S, or a door at the
room end). Walk the boundary of S in cyclic order.

**Interleave.** A and B interleave on S when some A sub-path and some B sub-path have endpoints in the order
A, B, A, B around the boundary of S. By the Jordan curve theorem two curves inside S with interleaved
endpoints must cross, regardless of how lanes are offset or where the corner coordinates are chosen. If no
pair interleaves on any shared stretch, lanes can be chosen without a crossing (crossing order along each
border is a linear order; the constraints between consecutive borders form a chain, so a consistent order
exists unless a pinned coordinate forces a violation).

**Planarity-style constraint.** The set of all chains is routable without different-edge floor crossings
iff for every shared stretch no two sub-paths interleave AND the pinned coordinates (door ends, plus the
coordinate a straight run inherits) do not force an interleaving on a border (a pinned-pinned conflict).
The cell-local N-S vs W-E case is the single-cell special case (S = one cell). The sweep-10 case is S = r0c1 +
r0c2: A west to south(r0c2), B south(r0c1) to east, perimeter order west, south(r0c1), south(r0c2), east
alternates A, B, A, B.

The exact decision procedure used by the prototype is not the topological test but the lane assignment
itself (see 3), which is a superset of it: it also detects pinned-coordinate conflicts. The topological test
is kept as the specification and as a cheap pre-filter for the real implementation.

## 3. Router change

`findCorridorPath` itself stays pure and unchanged (BFS shortest path, `exitFace` first-hop rule,
`incomingNeighbor` rule, occupied-cell blocking). Topology awareness is added around it as a sequential
placement loop:

1. Take every multi-cell edge of the layout (all real and hidden edges the scene would build) in a
   canonical order: target rank, target id, source id (the order `outgoingDoorPlan`'s `compareTargets`
   uses, so no dependence on object key order or on which room the scene builds first; shuffled input
   must give an identical result).
2. For each edge, build its chain with the real `buildEdgeCorridor` (door ends pinned from the outgoing
   plan and the incoming slots, exactly as today) and try to place it: assign its free corner coordinates
   (today's seeded value first, then nearest) so its floors intersect no already-placed edge's floor in any
   cell. First success wins.
3. On failure, re-route: add the cells of this chain that already carry a placed edge to a `blocked` set,
   rebuild the chain with those cells blocked (the prototype passes them as extra occupied cells; the real
   change should be an optional `blockedCells` option so `occupiedCells` keeps its meaning), and retry.
   Candidates are explored breadth-first over blocked sets in sorted order, with a fixed budget (40 tries).
   A candidate that becomes null (no path) is skipped, never turned into the direct-line fallback.
4. An edge with no placeable candidate is **unresolvable**. It is not drawn through shared floor
   (user Decision 2). What it becomes is a product question (section 7, Q-A).

Interactions:
- `exitFace` and the first-hop rule: untouched, because each candidate still goes through
  `findCorridorPath` with the same arguments.
- Incoming faces and merge targets: the last hop must still be the `incomingNeighbor`; blocking can make
  that unreachable (candidate skipped). Parents of one merge room are placed in canonical order and are just
  more edges (same-target stays separate lanes, Decision 3).
- Occupied cells: rooms still block everything. Phase 4's pass-through would later turn some occupied
  cells into passable cells for specific edges; the router needs no change for that beyond the `passage`
  option on `findCorridorPath`.
- Null-path edges (2,052 today): no chain, not part of the loop, unchanged.
- Composition with `outgoingDoorPlan` and `pruneConflictingShortcuts`: both run first, as today
  (positions, prune, incoming faces, door slots, outgoing plan); the router consumes their output. The
  router is a pure whole-layout pass computed once and read by the scene the same way `outgoingPlanFromState`
  is (no stored geometry; stored state stays small).
- Unknown (real risk, not measured): `findPriorityCollision`, `assignDoorSlotsWithPriority`,
  `outgoingMarginOffset` and `pendingForeignMarginOpenings` all call `findCorridorPath` on plain occupancy to
  decide door slots and foreign margin openings. A re-routed edge can take a different first hop or pass
  other rooms' margins than those functions assumed. The prototype keeps door ends pinned from the old
  computation, which is only valid if the re-routed first/last hop keeps the same face. The implementation
  must either re-derive slots after routing (a second pass; potentially unstable) or constrain re-routes to
  keep the first hop and the last hop (a restriction that may raise the unresolvable count). To be measured
  in the first implementation PR before wiring.

## 4. Measurements (prototype, 500 seeds, layoutVersion 2, 9,498 edges, 2,063 multi-cell)

Greedy fixed-path plan (PR B): 204 unresolvable. Topology-aware sequential router (this note):

| Measure | v2 baseline | Router prototype |
| --- | --- | --- |
| multi-cell edges placed with their shortest path | n/a | 1,842 |
| placed after re-routing | n/a | 36 |
| unresolvable | n/a | **185 (9.0%)** |
| floorCrossings among placed edges (real wall/floor check) | 484 | 0 |
| cutOccurrences among placed edges | 814 | 0 |
| path length of re-routed edges | n/a | +70 cells total (4,971 base, +1.4%); 23 edges +2, 6 edges +3..+4, 7 equal length |
| intermediate-room overlap introduced by re-routes | n/a | 0 |
| nullPath if unresolvable become null | 2,052 | up to 2,237 |
| interOverlap if unresolvable fall back to a direct line | 1,132 | up to 1,317 |
| cutEdges / cutOccurrences if unresolvable keep today's geometry | 501 / 814 | at most the edges involved with them (not measured separately) |

Sensitivity (first 100 seeds, 411 multi-cell edges): canonical 36 unresolvable, reverse 39,
shortest-chain-first 33, longest-chain-first 59. Raising the try budget from 40 to 400 on 500 seeds gives the
same 185, so the blocked-set search is exhausted, not under-budgeted. Edge order moves the number by a few
percent of itself; nothing approaches the 41 allowance.

Reading: re-routing around already-placed edges recovers only about 19 of 204. The remaining 185 mostly have
no non-interleaving route available through free cells (the single-column trunk leaves one way around),
not a lack of search. The sequential method also may not be optimal: a joint search with rip-up of earlier
edges could do somewhat better (order sensitivity suggests a few tens of edges at most). Not measured.

## 5. Kill criteria

- **K2' (this prototype): FAILED.** Allowance: unresolvable <= 2% of multi-cell edges (41). Measured 185.
- **K2'' (optional follow-up experiment, test-only):** a joint rip-up-and-reroute prototype (when an edge
  fails, retry with the conflicting earlier edge placed later, bounded iterations). If unresolvable stays
  above 5% of multi-cell edges (about 100), stop and take Q-A to a decision: do not keep optimizing.
- **K7 (implementation):** the router must keep found-path intermediate-room overlap at 0 (measured 0),
  keep total extra path length under 3% of base cells (measured 1.4%), and keep every other v2 ratchet
  (nullPath is judged on the combined boxed-in count, Q-A). Any rise is not mergeable (K1).
- **K8 (implementation):** if re-derived door slots or foreign margin openings (the section 3 unknown) make
  the real unresolvable count exceed the prototype's by more than 25%, stop and return to design.
- K1, K3-K6 unchanged.

## 6. What to do about the 185 (and if the router "also fails")

It has also failed K2'. The honest options for the unresolvable set U (about 2% of all edges, 9% of
multi-cell edges):

1. **Treat U as null-class in layoutVersion 3 (recommended).** Today these edges are drawn with a flank wall
   through their floor (the live check confirmed such a wall blocks movement and sight), i.e. they are already
   unusable corridors. In v3 they join the null set and are handled by the same machinery (Phase 4 passage,
   then Phase 5 stub, then Chunk 6 retreat). The `nullPath` ratchet is replaced by a combined **boxed-in**
   ratchet (null union unresolvable), starting at 2,052 + 185 = 2,237 for v3 and ratcheting down from there;
   `cutEdges`, `cutOccurrences` and `floorCrossings` go to 0 for v3. The interOverlap ratchet likewise tracks
   the combined set.
2. **Run K2'' first** (a joint rip-up prototype; test-only, about one PR) to see whether U shrinks enough to
   make the combined number less ugly. Cheap, but order sensitivity says the gain is small.
3. **Do Phase 4 before shipping the router.** Phase 4's pass-through creates routes through occupied cells'
   margin lanes, i.e. new alternatives for exactly the edges that had none; U should shrink, by an unknown
   amount (measure by extending the prototype after Phase 4 F1). Costs ordering: Phase 4 is the highest-risk
   chunk (#297 history).
4. **Relax Decision 2 for U** (let different-target corridors merge): rejected earlier; it breaks progression
   locks.
5. **Re-layout (Option D):** out of scope.

Sole-child fraction of U is unknown. If it matches the null set (79% sole-child), most of U cannot become a
stub until the retreat feature #439 lands, so v3 would draw them with the existing null-path direct-line
fallback until then (the same status quo as the 2,052 nulls).

## 7. Product questions raised

- **Q-A:** v3 may route about 185 more edges into the null class (a combined boxed-in ratchet; the plain
  nullPath number rises from 2,052 to about 2,237 on the sweep) in exchange for cuts and crossings going to 0
  everywhere else. Acceptable?
- **Q-B:** run K2'' (joint rip-up experiment) before implementation, or go straight to the sequential router?
- **Q-C:** ship the router before Phase 4 (U larger, Phase 4 later shrinks it) or after (U measured on
  Phase 4 geometry, but the highest-risk chunk goes first)?

## 8. layoutVersion 3 gating

Router, `lanes`/`blockedCells` arguments and the combined ratchet are v3 only. `buildEdgeCorridor` keeps its
signature (new optional trailing parameter); v1 and v2 stay byte-identical (the #425 digest tests must pass
unchanged). New runs stamp v3 in `scripts/ui/dungeon-app.mjs` like v2's stamp. Existing runs keep their
geometry. The router result is recomputed from state deterministically (pure function of seed, positions,
edges, hidden maps, faces, plans), not stored.

## 9. How Phase 4 and the stub phases fit

- Phase 4 (margin-lane pass-through): adds a `passage` option to `findCorridorPath`; a pass-through lane is
  one more chord in the shared-stretch model, so it is placed by the same router loop and checked by the same
  lane assignment. Its goal list gains "shrink U" alongside "shrink the 1,132 intermediate overlaps".
- Phase 5 (stub): `planStubs`' `nullEdges` input becomes null union U. The eligible counts (464 non-sole-child
  today) must be re-measured on the router's output; K6 invariants unchanged.
- Chunk 6 (retreat, #439): unchanged; it makes sole-child members of U stub-eligible too.

## 10. Prototype status

`tests/helpers/lane-prototype.mjs` (placer, chains, from PR #450) and `tests/helpers/topology-router.mjs`
(sequential router with blocked-cell re-routing; options `maxTries`, `order`) plus
`tests/dungeon-layout-topology-prototype.test.mjs` (first 100 seeds in the suite, about 18 s). Test-only; it
changes no behavior and is discarded or promoted into `scripts/` by Chunk 1's implementation PRs.

## 11. Implementation measurements (Task 3.1, pure router in `scripts/dungeon-layout.mjs`)

`routeEdgesTopologyAware` is the prototype's placer and blocked-cell search promoted to `scripts/`
(`makeLanePlacer`, `findCorridorPath`'s `blockedCells`, `buildEdgeCorridor`'s trailing `routing = { blockedCells }`). On the
500-seed sweep with layoutVersion 3 slots (incoming door order): 2,063 multi-cell edges, 1,842 placed on their shortest path, 36
placed after re-routing, 185 unresolvable (identical to the v2 prototype: the v3 door order does not change the router's
result), 0 floor crossings and 0 cut occurrences among placed edges on the real wall/floor check, +70 cells over 4,971 (+1.4%, K7
holds), tries 5,299.

**The section 3 unknown, measured.** Of the 36 re-routed edges, 20 change the first transit cell and 0 change the last (the
incoming-neighbor rule fixes the last hop). Door slots and foreign margin openings are not moved by a re-route in principle:
`findPriorityCollision`/`pendingForeignMarginOpenings` only act on null-path doglegs, which a re-route never produces (a
candidate that becomes null is skipped), and `outgoingMarginOffset` for a planned multi-cell edge returns the planned door
(offset and width independent of the path). What a changed first hop does change is connector 1 (source door to the first
transit cell), which runs through the source's own margin band; that is checked at the scene level in Task 3.2 (sealed-door
oracle). The option `keepFirstHop` (re-routes may not change the first transit cell) removes the question by construction:
14 re-routed, 199 unresolvable (+7.6% over 185, within K8's +25%), +20 cells.

## 12. Scene wiring measurements (Task 3.2, layoutVersion 3)

`buildEdgeCorridor`'s trailing `routing` parameter carries `{ blockedCells, lanes, unresolvable }` (built by
`makeRoutingFor(result)(edgeId)`); `outgoingMarginOffset` and `pendingForeignMarginOpenings` take the same `routingFor`
function so a forced-null edge's margin opening and dogleg opening are derived from its real geometry. The scene computes the
result once per layout (`routingFromState`, memoised, pure function of the persisted graph). Door slots still come from
`incomingSlotsV3` on plain occupancy, which is also what the router consumes (no circularity).

500-seed sweep, layoutVersion 3, router applied (real `buildEdgeCorridor` geometry): placed edges cutEdges 501 -> 0,
cutOccurrences 814 -> 0, floorCrossings 484 -> 0; found-path intermediate overlap 0; targetDoorCovered, chainMismatch,
sourceOverlap 0. Boxed in (null + unresolvable): 2,052 + 185 = 2,237. The 185 unresolvable edges are drawn as null paths,
so their fallback lines are counted in their own buckets (plain counters keep their v3 baselines): intermediate overlap 1,097 +
136, deep target overlap 160 + 56.

**K8, scene level.** Of 60 doors that are sealed in the routed scene and not in the order-only scene (200 seeds), 58 are
reveal doors of unresolvable edges and 2 are not on a routed edge; re-routed and placed edges add 0, so the 20 first-hop
changes are harmless and `keepFirstHop` is not needed (default off, 185 unresolvable). Sealed-door oracle, 200 seeds: 619
before the router (all doors) -> 605 on every edge but the unresolvable ones, plus 70 on the unresolvable ones (14 of the old
619 were their doors): total 675. A null edge no longer crosses the transit cell north/west of its target, whose containment
wall then covers the target door: the existing null-class residual, now inherited by 185 more edges.
