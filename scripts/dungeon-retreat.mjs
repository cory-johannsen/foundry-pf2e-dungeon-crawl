// scripts/dungeon-retreat.mjs
// #439: retreat to the last fork. Pure rules and reducers; no Foundry or other
// imports (same style as dungeon-deck.mjs). See
// docs/superpowers/specs/2026-10-01-retreat-design.md.
//
// Terms: a child is SPENT when it is judged (in state.history) or on the
// party's retreatPath; an OPEN child is a real non-stub child (state.edges)
// that is not spent. A DEAD-END room is the current, judged, non-goal room
// with no open child. A retreat goes to the nearest room on retreatPath
// (scanning back from the room before the current one) that has an open child.

export const RETREAT_VERSION = 1;

export function spentRooms(state) {
  const spent = new Set((state.history ?? []).map((h) => h.roomId));
  for (const id of state.retreatPath ?? []) spent.add(id);
  return spent;
}

export function openChildren(state, roomId) {
  const spent = spentRooms(state);
  return (state.edges?.[roomId] ?? []).filter((c) => !spent.has(c));
}

function isJudged(state, roomId) {
  return (state.history ?? []).some((h) => h.roomId === roomId);
}

export function isDeadEnd(state) {
  const room = state.rooms?.[state.currentRoomId];
  if (!room || room.isGoal) return false;
  if (!isJudged(state, state.currentRoomId)) return false;
  return openChildren(state, state.currentRoomId).length === 0;
}

export function retreatTargetFor(state) {
  const path = state.retreatPath ?? [];
  for (let i = path.length - 2; i >= 0; i -= 1) {
    if (openChildren(state, path[i]).length > 0) return path[i];
  }
  return null;
}

export function canRetreat(state, { combatActive = false } = {}) {
  if (!(state?.retreatVersion >= 1) || !Array.isArray(state.retreatPath)) return { ok: false, reason: 'disabled' };
  if (state.completed) return { ok: false, reason: 'completed' };
  if (!isJudged(state, state.currentRoomId)) return { ok: false, reason: 'unjudged' };
  if (combatActive) return { ok: false, reason: 'combat' };
  if (!isDeadEnd(state)) return { ok: false, reason: 'not-dead-end' };
  const stubs = state.stubEdges?.[state.currentRoomId] ?? [];
  const allOpened = stubs.every((t) => state.stubsOpened?.[`${state.currentRoomId}->${t}`]);
  if (!allOpened) return { ok: false, reason: 'undiscovered' };
  const targetId = retreatTargetFor(state);
  if (targetId == null) return { ok: false, reason: 'no-target' };
  return { ok: true, targetId };
}

export function withEntry(state, roomId) {
  if (!(state.retreatVersion >= 1)) return state;
  return { ...state, retreatPath: [...(state.retreatPath ?? []), roomId] };
}

export function withUndoneEntry(state, roomId) {
  if (!(state.retreatVersion >= 1)) return state;
  const path = state.retreatPath ?? [];
  if (path[path.length - 1] !== roomId) return state;
  return { ...state, retreatPath: path.slice(0, -1) };
}

export function withRetreat(state, at) {
  const verdict = canRetreat(state);
  if (!verdict.ok) throw new Error(`retreat refused: ${verdict.reason}`);
  const idx = state.retreatPath.lastIndexOf(verdict.targetId);
  return {
    ...state,
    currentRoomId: verdict.targetId,
    retreatPath: state.retreatPath.slice(0, idx + 1),
    lastAutoEntry: null,
    retreats: [...(state.retreats ?? []), { fromRoomId: state.currentRoomId, toRoomId: verdict.targetId, at }],
  };
}

export function withStubOpened(state, sourceId, targetId) {
  const key = `${sourceId}->${targetId}`;
  if (state.stubsOpened?.[key]) return state;
  return { ...state, stubsOpened: { ...(state.stubsOpened ?? {}), [key]: true } };
}

/** A valid chain from room-entry to currentRoomId over state.edges (shortest by BFS),
 * for the GM-only "Reset retreat path" repair; null when the current room is not reachable. */
export function rebuildRetreatPath(state) {
  const start = 'room-entry';
  const goal = state.currentRoomId;
  const prev = { [start]: null };
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    if (id === goal) {
      const path = [];
      for (let at = goal; at != null; at = prev[at]) path.unshift(at);
      return path;
    }
    for (const c of state.edges?.[id] ?? []) {
      if (!(c in prev)) { prev[c] = id; queue.push(c); }
    }
  }
  return null;
}

/** #439: the run-state fields a new run carries; empty for layoutVersion < 3 so
 * older runs stay byte-identical. */
export function retreatStateFor(layoutVersion) {
  if (!(layoutVersion >= 3)) return {};
  return { retreatVersion: RETREAT_VERSION, retreatPath: ['room-entry'], stubsOpened: {}, retreats: [] };
}
