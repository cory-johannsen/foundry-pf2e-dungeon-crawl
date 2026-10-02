// tests/helpers/passage-layout.mjs
// #427 Task 2.2: turns a sweep layout into the inputs of the pure lane planner (`planPassageLanes`), and
// measures what the planner serves. Everything here is derived from the same per-edge geometry the scene
// builds (`visitEdges`), never re-derived separately (the "independently re-derived trigger" bug class).
import {
  findCorridorPath, needsPassage, mouthTile, planPassageLanes,
} from '../../scripts/dungeon-layout.mjs';
import { visitEdges } from './buildability.mjs';

const area = (a, b) => Math.max(0, Math.min(a.gx + a.gw, b.gx + b.gw) - Math.max(a.gx, b.gx))
  * Math.max(0, Math.min(a.gy + a.gh, b.gy + b.gh) - Math.max(a.gy, b.gy));

/** One record per built edge, in `visitEdges` order, with the passage trigger already evaluated. */
export function passageEdges(layout, { unresolvableIds = new Set(), routed = false } = {}) {
  const { pos, occ, rect } = layout;
  const edges = [];
  visitEdges(layout, ({ sourceId, toId, face, sel, res, routing }) => {
    const path = findCorridorPath(pos[sourceId], pos[toId], occ,
      { fromRoomId: sourceId, toRoomId: toId, incomingFace: face, exitFace: sel.face });
    const floors = [...res.corridorSegments, ...res.transitCells.flatMap((c) => c.corridorSegments)];
    const overlapsOther = Object.entries(rect).some(([id, r]) => id !== sourceId && id !== toId && floors.some((s) => area(s, r) > 0));
    const edgeId = `${sourceId}->${toId}`;
    edges.push({
      edgeId, sourceId, toId, floors, res, sel, srcFace: sel.face, dstFace: face,
      srcMouth: mouthTile(res.doorWall, sel.face), dstMouth: mouthTile(res.revealDoorWall, face),
      nullPath: !path, overlapsOther,
      passage: needsPassage({ nullPath: !path, fallbackOverlapsOtherRoom: overlapsOther, unresolvable: unresolvableIds.has(edgeId) || routing?.unresolvable === true }),
    });
  }, { routed });
  return edges;
}

/** The planner's input object for a layout (edges may be passed in any order). */
export function passageInput(layout, edges = passageEdges(layout)) {
  return {
    positionByRoomId: layout.pos,
    rectByRoomId: layout.rect,
    edgeGeometry: edges.filter((e) => !e.passage).map((e) => ({ edgeId: e.edgeId, floors: e.floors, mouths: [e.srcMouth, e.dstMouth] })),
    targets: edges.filter((e) => e.passage).map((e) => ({
      edgeId: e.edgeId, sourceId: e.sourceId, toId: e.toId, srcMouth: e.srcMouth, dstMouth: e.dstMouth,
      srcFace: e.srcFace, dstFace: e.dstFace, floors: e.floors,
    })),
  };
}

export const ZERO_PLAN = () => ({
  targets: 0, served: 0, residual: 0, residualSoleChild: 0, servedTiles: 0, servedManhattan: 0, over2xManhattan: 0, maxCrossings: 0,
  maxExcessCrossings: 0,
});
export const sumPlan = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, k === 'maxCrossings' || k === 'maxExcessCrossings' ? Math.max(a[k], b[k]) : a[k] + b[k]]));

/** Plans a layout and counts what it serves. */
export function measurePlan(layout, { routed = false } = {}) {
  const edges = passageEdges(layout, { routed });
  const lanes = planPassageLanes(passageInput(layout, edges));
  const m = ZERO_PLAN();
  for (const e of edges.filter((x) => x.passage)) {
    m.targets += 1;
    const lane = lanes.get(e.edgeId);
    if (!lane) {
      m.residual += 1;
      if ((layout.edges[e.sourceId] ?? []).length === 1) m.residualSoleChild += 1;
      continue;
    }
    m.served += 1;
    m.servedTiles += lane.tiles.length;
    const manhattan = Math.abs(e.srcMouth.x - e.dstMouth.x) + Math.abs(e.srcMouth.y - e.dstMouth.y) + 1;
    m.servedManhattan += manhattan;
    if (lane.tiles.length > 2 * manhattan) m.over2xManhattan += 1;
    const crossings = Object.values(lane.openingsByCell).reduce((n, list) => n + list.length, 0) / 2;
    m.maxCrossings = Math.max(m.maxCrossings, crossings);
    const ps = layout.pos[e.sourceId]; const pt = layout.pos[e.toId];
    m.maxExcessCrossings = Math.max(m.maxExcessCrossings, crossings - (Math.abs(ps.rank - pt.rank) + Math.abs(ps.col - pt.col)));
  }
  return { m, edges, lanes };
}
