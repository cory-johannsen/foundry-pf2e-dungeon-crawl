// #427 Chunk 6 test helper: the stub planner's inputs for a sweep layout, and a stub-aware copy of the layout.
import { planStubsForLayout, applyStubsToEdges } from '../../scripts/dungeon-layout.mjs';
import { buildSweepLayout } from './layout-sweep.mjs';

/** The pure planner's input record for a sweep layout (what dungeon-app.mjs passes at precompute). */
export function stubInputsFor(L) {
  return {
    seed: L.seed, rooms: L.rooms, positionByRoomId: L.pos, occupiedCells: L.occ, edges: L.edges, layoutEdges: L.layoutEdges,
    hiddenEdges: L.hiddenEdges, hiddenRooms: L.hiddenRooms, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId,
    incomingFaceByRoomId: L.incFace,
  };
}

/** A v3 sweep layout whose progression graph has the planned stubs removed and `stubEdges` / `stubGeometries`
 * attached, exactly as a stubbed run's state would be. `retreatAvailable` turns on sole-child stubs (Chunk 7). */
export function buildStubbedSweepLayout(i, { retreatAvailable = false, layoutVersion = 3, seed } = {}) {
  const L = buildSweepLayout(i, { layoutVersion, seed }); // #490: `seed` = a reseeded candidate
  const plan = planStubsForLayout({ ...stubInputsFor(L), retreatAvailable });
  return {
    ...L, edges: applyStubsToEdges(L.edges, plan.stubEdges), baseEdges: L.edges,
    stubEdges: plan.stubEdges, stubGeometries: plan.geometries, stubPlan: plan,
  };
}
