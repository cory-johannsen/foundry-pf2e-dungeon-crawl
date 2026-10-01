// tests/helpers/layout-sweep.mjs
// Mirrors buildPopulateAndUnlockGraphNode (scripts/dungeon-scene.mjs ~1128-1230)
// and the precompute in scripts/ui/dungeon-app.mjs (~500-530), so a sweep sees
// exactly what a real run builds. The older #174 sweeps do NOT: they skip
// hidden edges, exclude an edge's own endpoints and use one north slot.
import { buildRoomGraph, attachHiddenPaths } from '../../scripts/dungeon-deck.mjs';
import {
  computeRanks, computeColumns, roomRect, incomingFaceFor, parentRoomIdsFor,
  incomingConnectionsFor, findPriorityCollision, assignDoorSlotsWithPriority,
  exitFaceForIndex, buildEdgeCorridor,
} from '../../scripts/dungeon-layout.mjs';

export function rectsOverlap(a, b) {
  return a.gx < b.gx + b.gw && a.gx + a.gw > b.gx && a.gy < b.gy + b.gh && a.gy + a.gh > b.gy;
}

export function buildSweepLayout(i) {
  const seed = `sweep-${i}`;
  const roomCount = 6 + (i % 15);
  const { rooms, edges } = buildRoomGraph({ seed, roomCount });
  const { layoutEdges, hiddenIncomingByRoomId, hiddenEdges, hiddenRooms } = attachHiddenPaths({ rooms, edges, seed });
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const cols = computeColumns(layoutEdges, ranks, 'room-entry');
  const ids = Object.keys(rooms);
  const pos = Object.fromEntries(ids.map((id) => [id, { rank: ranks[id], col: cols[id] }]));
  const occ = Object.fromEntries(Object.entries(pos).map(([id, p]) => [`${p.rank},${p.col}`, id]));
  const rect = Object.fromEntries(ids.map((id) => [id, roomRect(seed, id, pos[id].rank, pos[id].col)]));
  const incFace = Object.fromEntries(ids.map((id) => [id, incomingFaceFor(
    id, pos, occ,
    new Set([...parentRoomIdsFor(layoutEdges, id), ...(hiddenIncomingByRoomId[id] ?? [])]),
  )]));
  return { seed, rooms, edges, hiddenEdges: hiddenEdges ?? {}, hiddenRooms: [...(hiddenRooms ?? [])], layoutEdges, hiddenIncomingByRoomId, pos, occ, rect, incFace };
}

/** Today's selection: face by child index (dungeon-scene.mjs ~1219). */
export function legacyExitSelector(layout, { sourceId, toId, hidden }) {
  const kids = layout.edges[sourceId] ?? [];
  const sf = layout.incFace[sourceId];
  const face = hidden ? exitFaceForIndex(kids.length, sf) : exitFaceForIndex(kids.indexOf(toId), sf);
  return { face, exitDoor: undefined };
}

export function forEachEdge(seedCount, exitSelector, visit) {
  for (let i = 0; i < seedCount; i += 1) {
    const layout = buildSweepLayout(i);
    const { seed, pos, occ, rect, incFace, layoutEdges, hiddenIncomingByRoomId, hiddenRooms } = layout;
    for (const toId of Object.keys(layout.rooms)) {
      const isDetour = hiddenRooms.includes(toId);
      const conns = incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId)
        .map((c) => (isDetour ? { ...c, hidden: true } : c));
      if (!conns.length) continue;
      const face = incFace[toId];
      const collision = findPriorityCollision(seed, toId, pos[toId].rank, pos[toId].col, conns, pos, occ, face);
      const slots = assignDoorSlotsWithPriority(seed, rect[toId], conns, face, collision);
      conns.forEach(({ sourceId, hidden }, k) => {
        const sel = exitSelector(layout, { sourceId, toId, hidden });
        if (sel.face == null) return; // legacy index past the candidate list; not a built edge
        const result = buildEdgeCorridor(
          seed, sourceId, toId, rect[sourceId], rect[toId], pos[sourceId], pos[toId],
          sel.face, slots[k], occ, face, sel.exitDoor,
        );
        const segments = [...result.corridorSegments, ...result.transitCells.flatMap((c) => c.corridorSegments)];
        visit({ layout, sourceId, toId, hidden, face: sel.face, exitDoor: sel.exitDoor, toSlot: slots[k], result, segments });
      });
    }
  }
}
