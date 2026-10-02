// tests/helpers/router-layout.mjs
// #427 Chunk 3: inputs for routeEdgesTopologyAware, and the real wall/floor check on its lanes.
import {
  roomRect, outgoingDoorPlan, incomingSlotsV3, incomingFaceFor, parentRoomIdsFor,
  transitCellCrossing, transitCellContainmentWalls,
} from '../../scripts/dungeon-layout.mjs';
import { visitEdges } from './buildability.mjs';
import { planSelector } from './layout-sweep.mjs';

/** Router inputs for a sweep layout: the slots every edge actually received (any layoutVersion), the same
 * outgoing plan the scene uses. */
export function routerInputsFor(layout) {
  const slots = new Map();
  visitEdges(layout, ({ sourceId, toId, slot }) => {
    if (!slots.has(toId)) slots.set(toId, []);
    slots.get(toId).push({ sourceId, slot });
  });
  return {
    seed: layout.seed, positionByRoomId: layout.pos, occupiedCells: layout.occ, layoutEdges: layout.layoutEdges,
    hiddenIncomingByRoomId: layout.hiddenIncomingByRoomId, incomingFaceByRoomId: layout.incFace,
    planFor: planSelector.planFor(layout), slotsForRoom: (id) => slots.get(id) ?? [],
  };
}

/** Router inputs for a hand-built grid: `pos` {id: {rank, col}}, `edges` {id: [childIds]}. Slots from
 * incomingSlotsV3 (the v3 order), plan from outgoingDoorPlan, incoming face from incomingFaceFor unless `faces` says. */
export function fixtureInputs(pos, edges, { seed = 'fixture', faces = {} } = {}) {
  const occ = Object.fromEntries(Object.entries(pos).map(([id, p]) => [`${p.rank},${p.col}`, id]));
  const incFace = Object.fromEntries(Object.keys(pos).map((id) => [id, faces[id]
    ?? incomingFaceFor(id, pos, occ, new Set(parentRoomIdsFor(edges, id)))]));
  const planFor = (sourceId) => outgoingDoorPlan(
    roomRect(seed, sourceId, pos[sourceId].rank, pos[sourceId].col), pos[sourceId],
    { realChildIds: edges[sourceId] ?? [], hiddenChildIds: [] }, pos,
  );
  return {
    seed, positionByRoomId: pos, occupiedCells: occ, layoutEdges: edges, hiddenIncomingByRoomId: {},
    incomingFaceByRoomId: incFace, planFor,
    slotsForRoom: (toId) => incomingSlotsV3(seed, toId, pos[toId], {
      layoutEdges: edges, hiddenIncomingByRoomId: {}, positionByRoomId: pos, occupiedCells: occ,
      incomingFace: incFace[toId], planFor,
    }).map(({ sourceId, slot }) => ({ sourceId, slot })),
  };
}

const area = (a, b) => Math.max(0, Math.min(a.gx + a.gw, b.gx + b.gw) - Math.max(a.gx, b.gx))
  * Math.max(0, Math.min(a.gy + a.gh, b.gy + b.gh) - Math.max(a.gy, b.gy));
const cuts = (w, f) => (w.y1 === w.y2
  ? f.gy < w.y1 && w.y1 < f.gy + f.gh && Math.max(Math.min(w.x1, w.x2), f.gx) < Math.min(Math.max(w.x1, w.x2), f.gx + f.gw)
  : f.gx < w.x1 && w.x1 < f.gx + f.gw && Math.max(Math.min(w.y1, w.y2), f.gy) < Math.min(Math.max(w.y1, w.y2), f.gy + f.gh));

/** The real floor/wall check on router lanes (the model is not trusted): per transit cell, every edge's floor
 * from `transitCellCrossing` with the lane's forced points, the cell's containment walls over all crossings plus
 * each crossing's flank walls. Returns `{ floorCrossings, cutOccurrences, cellsShared }`. */
export function checkLanes(seed, lanes) {
  const uses = new Map();
  for (const [edgeId, cells] of lanes) {
    for (const [key, l] of cells) {
      const [rank, col] = key.split(',').map(Number);
      const cr = transitCellCrossing(seed, rank, col, l.entrySide, l.exitSide, edgeId, {
        forcedEntryPoint: l.entryPoint, forcedExitPoint: l.exitPoint,
      });
      if (!uses.has(key)) uses.set(key, []);
      uses.get(key).push({ id: edgeId, floors: cr.corridorSegments, plainWalls: cr.plainWalls,
        openings: [{ side: l.entrySide, point: cr.entryPoint }, { side: l.exitSide, point: cr.exitPoint }] });
    }
  }
  let floorCrossings = 0; let cutOccurrences = 0; let cellsShared = 0;
  for (const [key, list] of uses) {
    const [rank, col] = key.split(',').map(Number);
    const walls = [...transitCellContainmentWalls(rank, col, list.flatMap((u) => u.openings)), ...list.flatMap((u) => u.plainWalls)];
    if (list.length > 1) cellsShared += 1;
    for (const u of list) if (u.floors.some((f) => walls.some((w) => cuts(w, f)))) cutOccurrences += 1;
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) {
      if (list[a].floors.some((x) => list[b].floors.some((y) => area(x, y) > 0))) floorCrossings += 1;
    }
  }
  return { floorCrossings, cutOccurrences, cellsShared };
}
