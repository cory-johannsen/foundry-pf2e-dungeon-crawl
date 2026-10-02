// #603 PROTOTYPE (test helper): column placement variants for merge rooms. The dominant dead edge (gate-held, 1,040 of 1,201 sealed
// doors) is a merge room M whose co-parent H sits directly above it (same trunk column) while the second parent S is EAST of M:
// every route into M's one north gate cell passes through H. Moving M east of all its parents makes both approach from the
// west (the shape that is almost never null today). `computeRunLayoutWith` is `computeRunLayout` (scripts/dungeon-reseed.mjs)
// with the column function swapped.
import {
  computeRanks, computeColumns, parentRoomIdsFor, incomingFaceFor, pruneConflictingShortcuts, NEW_RUN_LAYOUT_VERSION,
} from '../../scripts/dungeon-layout.mjs';

/** Standard columns, then every merge room (2+ parents in `layoutEdges`) moves to the first free even column east of its parents'. */
export function computeColumnsMergeEast(edges, ranks, entryId, { mode = 'east' } = {}) {
  const columns = { ...computeColumns(edges, ranks, entryId) };
  const byRank = {};
  for (const id of Object.keys(columns)) (byRank[ranks[id]] ??= []).push(id);
  const maxRank = Math.max(...Object.values(ranks));
  for (let r = 1; r <= maxRank; r += 1) {
    const rooms = (byRank[r] ?? []).sort((a, b) => columns[a] - columns[b]);
    const used = new Set(rooms.map((id) => columns[id]));
    for (const id of rooms) {
      const parents = parentRoomIdsFor(edges, id);
      if (parents.length < 2) continue;
      const parentCols = parents.map((p) => columns[p]);
      if (mode === 'east') {
        // Only needed when a parent is directly above (the gate holder) -- else leave it where it is.
        if (!parents.some((p) => ranks[p] === r - 1 && columns[p] === columns[id])) continue;
        let c = Math.max(...parentCols) + 2;
        while (used.has(c)) c += 2;
        used.delete(columns[id]); used.add(c); columns[id] = c;
      }
    }
  }
  return columns;
}

export function computeRunLayoutWith({ generator, seed, roomCount, columnsFn, layoutVersion = NEW_RUN_LAYOUT_VERSION, topologyRouting = false }) {
  const generated = generator.buildRoomGraph({ seed, roomCount });
  const { rooms, edges: edgesBeforeStubs } = generator.insertRestRoom({ rooms: generated.rooms, edges: generated.edges, seed, roomCount });
  const { hiddenRooms, hiddenEdges: attachedHiddenEdges, layoutEdges, hiddenIncomingByRoomId: attachedHiddenIncoming } =
    generator.attachHiddenPaths({ rooms, edges: edgesBeforeStubs, seed });
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const columns = columnsFn(layoutEdges, ranks, 'room-entry');
  const layoutPositionByRoomId = Object.fromEntries(Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]));
  const { hiddenEdges, hiddenIncomingByRoomId } = pruneConflictingShortcuts({
    edges: edgesBeforeStubs, hiddenRooms, hiddenEdges: attachedHiddenEdges, hiddenIncomingByRoomId: attachedHiddenIncoming,
  }, layoutPositionByRoomId);
  const occupiedCells = {};
  for (const [id, pos] of Object.entries(layoutPositionByRoomId)) occupiedCells[`${pos.rank},${pos.col}`] = id;
  const incomingFaceByRoomId = Object.fromEntries(Object.keys(rooms).map((id) => {
    const legit = new Set([...parentRoomIdsFor(layoutEdges, id), ...(hiddenIncomingByRoomId[id] ?? [])]);
    return [id, incomingFaceFor(id, layoutPositionByRoomId, occupiedCells, legit)];
  }));
  return {
    seed, layoutVersion, rooms, edges: edgesBeforeStubs, layoutEdges, hiddenRooms: [...hiddenRooms], hiddenEdges, hiddenIncomingByRoomId,
    layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
    maxRank: Math.max(...Object.values(ranks)), maxCol: Math.max(...Object.values(columns)),
    ...(topologyRouting && layoutVersion >= 3 ? { topologyRouting: true } : {}),
  };
}
