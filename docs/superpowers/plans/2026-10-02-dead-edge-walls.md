# #585 Dead-edge walls: implementation plan

Spec: docs/superpowers/specs/2026-10-02-dead-edge-walls-design.md. Test-first throughout.

## PR 1: walled edges in layout, scene and planner

1. Tests first (fail): `walledEdges` is excluded by `incomingConnectionsFor` / `incomingSlotsV3` (no slot, siblings
   re-slot), builds no corridor and no door, leaves a solid wall over the whole former door span, and opens no margin
   gap (tests/dungeon-layout-walled.test.mjs + a scene test through `buildSceneForLayout`).
2. `scripts/dungeon-layout.mjs`: `walledEdges` param (default `{}`) on the excluded-edge consumers; helper
   `mergeEdgeMaps`; `applyStubsToEdges` also strips walled edges.
3. `scripts/dungeon-scene.mjs`: `buildRoomAtGraphNode` / `buildPopulateAndUnlockGraphNode` read `state.walledEdges`
   (layoutVersion >= 3 only) and pass it through.
4. `scripts/dungeon-stub-oracle.mjs`: `planStubsVerified` runs the wall fixpoint after the stub verify and returns
   `walledEdges`; `scripts/dungeon-reseed.mjs` scratch scene honours `walledEdges`; the verdict is the final scene's.
5. `scripts/ui/dungeon-app.mjs` (run creation) stores `walledEdges` + `deadEdgeWalls: true` and `edges` without them.
6. Sweeps (500 seeds): no dead real edge remains, no sealed door, goal reachable, no reachable room lost,
   buildability / door-corridor / walkability sweeps unchanged or better, reseed predicate consistent (N = 20 pass rate).

## PR 2: Turn back at any dead end

1. Tests first: `retreatUiFor` / `canRetreat` for a judged room with no forward edge and no stub (walled dead end),
   announce on resolve gated by `deadEdgeWalls`, flavor line, old run (no flag) unchanged, soft-lock property test
   against the real plan with walled edges (sensible / careless / adversarial walkers).
2. `scripts/dungeon-retreat.mjs`: `retreatStateFor` stamps nothing new (flag lives with the plan); document gating.
3. `scripts/dungeon-scene.mjs`: announce when a judged room is a dead end (no stub), post `NoWayForward` first.
4. `lang/en.json`: `PF2EDC.Dungeon.Retreat.NoWayForward`.
