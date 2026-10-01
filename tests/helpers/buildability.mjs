// tests/helpers/buildability.mjs
// Whole-layout buildability measurement for #427 (counts only, no behavior).
import {
  buildEdgeCorridor, findCorridorPath, findPriorityCollision, assignDoorSlotsWithPriority,
  incomingConnectionsFor, cellBounds, transitCellContainmentWalls,
} from '../../scripts/dungeon-layout.mjs';
import { planSelector } from './layout-sweep.mjs';

const area = (a, b) => Math.max(0, Math.min(a.gx + a.gw, b.gx + b.gw) - Math.max(a.gx, b.gx))
  * Math.max(0, Math.min(a.gy + a.gh, b.gy + b.gh) - Math.max(a.gy, b.gy));
const overlap = (a, b) => area(a, b) > 0;
const cuts = (w, f) => (w.y1 === w.y2
  ? f.gy < w.y1 && w.y1 < f.gy + f.gh && Math.max(Math.min(w.x1, w.x2), f.gx) < Math.min(Math.max(w.x1, w.x2), f.gx + f.gw)
  : f.gx < w.x1 && w.x1 < f.gx + f.gw && Math.max(Math.min(w.y1, w.y2), f.gy) < Math.min(Math.max(w.y1, w.y2), f.gy + f.gh));

export const ZERO = () => ({
  edges: 0, nullPath: 0, interOverlap: 0, interOverlapFound: 0, targetOverlapDeep: 0,
  multi: 0, sharedCells: 0, cutOccurrences: 0, cutEdges: 0, floorCrossings: 0, targetDoorCovered: 0,
  chainMismatch: 0, sourceOverlap: 0,
});
export const sumMeasures = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]]));

/** Mirrors the scene's per-room build (door slots with priority, planned exit doors): calls
 * `visit({ sourceId, toId, face, sel, slot, res })` once for every built edge of the layout. */
export function visitEdges(layout, visit) {
  const { seed, rooms, layoutEdges, hiddenIncomingByRoomId, hiddenRooms, pos, occ, rect, incFace } = layout;
  const planFor = planSelector.planFor(layout);
  for (const toId of Object.keys(rooms)) {
    const isDetour = hiddenRooms.includes(toId);
    const conns = incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId)
      .map((c) => (isDetour ? { ...c, hidden: true } : c));
    if (!conns.length) continue;
    const face = incFace[toId];
    const collision = findPriorityCollision(seed, toId, pos[toId].rank, pos[toId].col, conns, pos, occ, face, planFor);
    const slots = assignDoorSlotsWithPriority(seed, rect[toId], conns, face, collision);
    conns.forEach(({ sourceId }, k) => {
      const sel = planSelector(layout, { sourceId, toId });
      const res = buildEdgeCorridor(seed, sourceId, toId, rect[sourceId], rect[toId], pos[sourceId], pos[toId],
        sel.face, slots[k], occ, face, sel.exitDoor);
      visit({ sourceId, toId, face, sel, slot: slots[k], res });
    });
  }
}

export function measureBuildability(layout, { cellUse = new Map() } = {}) {
  // `cellUse` (optional, filled): "rank,col" -> [{ id, c }], every edge's transit-cell crossing; the
  // oracle test reads it.
  const m = ZERO();
  const { pos, occ, rect } = layout;
  visitEdges(layout, ({ sourceId, toId, face, sel, res }) => {
      const segs = [...res.corridorSegments, ...res.transitCells.flatMap((c) => c.corridorSegments)];
      const path = findCorridorPath(pos[sourceId], pos[toId], occ,
        { fromRoomId: sourceId, toRoomId: toId, incomingFace: face, exitFace: sel.face });
      m.edges += 1;
      if (!path) m.nullPath += 1;
      const inter = Object.entries(rect).some(([id, r]) => id !== sourceId && id !== toId && segs.some((s) => overlap(s, r)));
      if (inter) { m.interOverlap += 1; if (path) m.interOverlapFound += 1; }
      if (segs.some((s) => area(s, rect[toId]) >= 2)) m.targetOverlapDeep += 1;
      if (segs.some((s) => overlap(s, rect[sourceId]))) m.sourceOverlap += 1;
      if (res.transitCells.length) {
        m.multi += 1;
        for (let i = 0; i + 1 < res.transitCells.length; i += 1) {
          const a = res.transitCells[i].exitPoint; const b = res.transitCells[i + 1].entryPoint;
          if (a.x !== b.x || a.y !== b.y) m.chainMismatch += 1;
        }
        const last = res.transitCells.at(-1);
        const bounds = cellBounds(last.rank, last.col);
        const walls = transitCellContainmentWalls(last.rank, last.col, [{ side: last.exitSide, point: last.exitPoint }])
          .filter((w) => w.dir === last.exitSide);
        const horiz = last.exitSide === 'north' || last.exitSide === 'south';
        const cs = horiz ? bounds.gx : bounds.gy; const ce = horiz ? bounds.gx + bounds.gw : bounds.gy + bounds.gh;
        const bw = walls.find((w) => (horiz ? w.x1 : w.y1) === cs); const aw = walls.find((w) => (horiz ? w.x2 : w.y2) === ce);
        const gs = bw ? (horiz ? bw.x2 : bw.y2) : cs; const ge = aw ? (horiz ? aw.x1 : aw.y1) : ce;
        const [ds, de] = horiz ? [res.revealDoorWall.x1, res.revealDoorWall.x2] : [res.revealDoorWall.y1, res.revealDoorWall.y2];
        if (Math.abs(gs - Math.min(ds, de)) > 1e-9 || Math.abs(ge - Math.max(ds, de)) > 1e-9) m.targetDoorCovered += 1;
        for (const c of res.transitCells) {
          const key = `${c.rank},${c.col}`;
          if (!cellUse.has(key)) cellUse.set(key, []);
          cellUse.get(key).push({ id: `${sourceId}->${toId}`, c });
        }
      }
  });
  const cutEdges = new Set();
  for (const [key, uses] of cellUse) {
    const [rank, col] = key.split(',').map(Number);
    const walls = [
      ...transitCellContainmentWalls(rank, col, uses.flatMap(({ c }) => [
        { side: c.entrySide, point: c.entryPoint }, { side: c.exitSide, point: c.exitPoint }])),
      ...uses.flatMap(({ c }) => c.plainWalls ?? []),
    ];
    if (uses.length > 1) m.sharedCells += 1;
    for (const { id, c } of uses) {
      if (c.corridorSegments.some((f) => walls.some((w) => cuts(w, f)))) { cutEdges.add(id); m.cutOccurrences += 1; }
    }
    for (let a = 0; a < uses.length; a += 1) {
      for (let b = a + 1; b < uses.length; b += 1) {
        if (uses[a].id !== uses[b].id
          && uses[a].c.corridorSegments.some((x) => uses[b].c.corridorSegments.some((y) => overlap(x, y)))) m.floorCrossings += 1;
      }
    }
  }
  m.cutEdges = cutEdges.size;
  return m;
}
