// tests/helpers/layout-sweep.mjs
// Mirrors buildPopulateAndUnlockGraphNode (scripts/dungeon-scene.mjs ~1128-1230)
// and the precompute in scripts/ui/dungeon-app.mjs (~500-530), so a sweep sees
// exactly what a real run builds. The older #174 sweeps do NOT: they skip
// hidden edges, exclude an edge's own endpoints and use one north slot.
import { buildRoomGraph, attachHiddenPaths, insertRestRoom } from '../../scripts/dungeon-deck.mjs';
import {
  computeRanks, computeColumns, roomRect, incomingFaceFor, parentRoomIdsFor,
  incomingConnectionsFor, findPriorityCollision, assignDoorSlotsWithPriority,
  exitFaceForIndex, buildEdgeCorridor, outgoingDoorPlan, pruneConflictingShortcuts,
} from '../../scripts/dungeon-layout.mjs';

export function rectsOverlap(a, b) {
  return a.gx < b.gx + b.gw && a.gx + a.gw > b.gx && a.gy < b.gy + b.gh && a.gy + a.gh > b.gy;
}

/** `restRoom` (default true) mirrors dungeon-app.mjs, which splices the mid-dungeon
 * rest room in before attachHiddenPaths. The #415 Chunk 1-3 baselines (and the
 * default-geometry digest test) were measured without it, so they pass false. */
export function buildSweepLayout(i, { restRoom = true, layoutVersion = 1, incomingFace, seed: seedOverride, roomCount: roomCountOverride } = {}) {
  // #490: `seed` re-derives the same dungeon shape for a reseeded candidate; `i` still picks the room count.
  const seed = seedOverride ?? `sweep-${i}`;
  const roomCount = roomCountOverride ?? (6 + (i % 15));
  const generated = buildRoomGraph({ seed, roomCount });
  const { rooms, edges } = restRoom
    ? insertRestRoom({ rooms: generated.rooms, edges: generated.edges, seed, roomCount })
    : generated;
  const attached = attachHiddenPaths({ rooms, edges, seed });
  const { layoutEdges, hiddenRooms } = attached;
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const cols = computeColumns(layoutEdges, ranks, 'room-entry');
  const ids = Object.keys(rooms);
  const pos = Object.fromEntries(ids.map((id) => [id, { rank: ranks[id], col: cols[id] }]));
  // #415 Chunk 5 (layoutVersion >= 2): mirrors dungeon-app.mjs, which prunes between positions and incoming faces.
  const { hiddenEdges, hiddenIncomingByRoomId } = layoutVersion >= 2
    ? pruneConflictingShortcuts({ edges, hiddenRooms, hiddenEdges: attached.hiddenEdges, hiddenIncomingByRoomId: attached.hiddenIncomingByRoomId }, pos)
    : attached;
  const occ = Object.fromEntries(Object.entries(pos).map(([id, p]) => [`${p.rank},${p.col}`, id]));
  const rect = Object.fromEntries(ids.map((id) => [id, roomRect(seed, id, pos[id].rank, pos[id].col)]));
  const incFace = Object.fromEntries(ids.map((id) => [id, incomingFaceFor(
    id, pos, occ,
    new Set([...parentRoomIdsFor(layoutEdges, id), ...(hiddenIncomingByRoomId[id] ?? [])]),
  )]));
  const layout = { layoutVersion, seed, rooms, edges, hiddenEdges: hiddenEdges ?? {}, hiddenRooms: [...(hiddenRooms ?? [])], layoutEdges, hiddenIncomingByRoomId, pos, occ, rect, incFace };
  // #427: tests may force the incoming face (e.g. 'west' for every room) to measure that geometry.
  if (incomingFace) {
    for (const id of ids) layout.incFace[id] = incomingFace(id, layout);
  }
  return layout;
}

/** Today's selection: face by child index (dungeon-scene.mjs ~1219). */
export function legacyExitSelector(layout, { sourceId, toId, hidden }) {
  const kids = layout.edges[sourceId] ?? [];
  const sf = layout.incFace[sourceId];
  const face = hidden ? exitFaceForIndex(kids.length, sf) : exitFaceForIndex(kids.indexOf(toId), sf);
  return { face, exitDoor: undefined };
}

export function forEachEdge(seedCount, exitSelector, visit, layoutOptions) {
  for (let i = 0; i < seedCount; i += 1) {
    const layout = buildSweepLayout(i, { layoutVersion: exitSelector.layoutVersion ?? 1, ...layoutOptions });
    // The scene passes the source plan to findPriorityCollision under layoutVersion 2.
    const planFor = exitSelector.planFor?.(layout);
    const { seed, pos, occ, rect, incFace, layoutEdges, hiddenIncomingByRoomId, hiddenRooms } = layout;
    for (const toId of Object.keys(layout.rooms)) {
      const isDetour = hiddenRooms.includes(toId);
      const conns = incomingConnectionsFor(layoutEdges, toId, hiddenIncomingByRoomId)
        .map((c) => (isDetour ? { ...c, hidden: true } : c));
      if (!conns.length) continue;
      const face = incFace[toId];
      const collision = findPriorityCollision(seed, toId, pos[toId].rank, pos[toId].col, conns, pos, occ, face, planFor);
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

/** Plan-driven selector (#415 Chunk 2): the exit face and door the outgoing plan
 * assigns to the sourceId -> toId edge. `exitDoor` is only set when the face
 * carries several doors (single-door faces stay on the legacy path). Used by
 * Chunk 4. */
export function planSelector(layout, { sourceId, toId }) {
  const entry = outgoingPlanFor(layout, sourceId).get(toId);
  return { face: entry.face, exitDoor: entry };
}
planSelector.layoutVersion = 2;
planSelector.planFor = (layout) => (sourceId) => outgoingPlanFor(layout, sourceId);

/** The plan for one source room, from the same inputs the scene has: real
 * children plus the (single) hidden child, target positions from the layout. */
export function outgoingPlanFor(layout, sourceId) {
  return outgoingDoorPlan(
    layout.rect[sourceId], layout.pos[sourceId],
    { realChildIds: layout.edges[sourceId] ?? [], hiddenChildIds: (layout.hiddenEdges[sourceId] ?? []).slice(0, 1) },
    layout.pos,
  );
}
