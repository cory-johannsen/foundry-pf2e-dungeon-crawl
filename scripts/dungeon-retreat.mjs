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

/**
 * #585: the current room has no walkable forward exit and no stub door to find: every forward edge was WALLED at
 * precompute (a dead edge that could not become a stub gets no door, scripts/dungeon-reseed.mjs). Only runs stamped
 * `deadEdgeWalls` announce it (a run created before the walls keeps its old behavior), and only for a non-goal room
 * with retreat on. A room with a stub is not announced here: its stub door is discovered by opening it (Decision 10).
 * `canRetreat` needs no change for this: a judged room with no open child and no stub has nothing left to discover,
 * so `Turn back` is offered the moment the room is judged.
 */
export function hasNoWayForward(state) {
  if (!state?.deadEdgeWalls || !(state.retreatVersion >= 1)) return false;
  const id = state.currentRoomId;
  const room = state.rooms?.[id];
  if (!room || room.isGoal) return false;
  return (state.edges?.[id] ?? []).length === 0 && (state.stubEdges?.[id] ?? []).length === 0;
}

const ROOM_KIND_WORDS = {
  safe_entry: 'entry', safe_rest: 'rest', skill_challenge: 'skill challenge', combat: 'combat',
  trap: 'trap', puzzle: 'puzzle', narrative: 'narrative', treasure: 'treasure',
};
const ENGLISH_I18N = {
  localize: (key) => {
    if (key === 'PF2EDC.Dungeon.Retreat.PreviousRoom') return 'the previous room';
    if (key === 'PF2EDC.Dungeon.RoomTile.Goal') return 'Goal';
    if (key === 'PF2EDC.Dungeon.RoomTile.Generic') return 'Room';
    if (key.includes('RoomTile.Kind.')) {
      const w = ROOM_KIND_WORDS[key.split('.').pop()];
      return w ? w[0].toUpperCase() + w.slice(1) : key;
    }
    return ROOM_KIND_WORDS[key.split('.').pop()] ?? key;
  },
  format: (key, d) => (key.endsWith('RoomTile.Name') ? `${d.kind} (rank ${d.rank}, col ${d.col})` : key.endsWith('NoRank') ? `the ${d.kind} room` : `the ${d.kind} room (rank ${d.rank})`),
};

/** #577: a readable name for a room in retreat text. Generated rooms have no `name`, so build one from the room
 * kind and layout rank; an explicit name wins, and an unknown room/kind gives a generic label (never a raw id).
 * `i18n` ({localize, format}) defaults to English; the scene layer passes game.i18n. */
export function roomDisplayLabel(state, roomId, i18n = ENGLISH_I18N) {
  const room = state?.rooms?.[roomId];
  if (room?.name) return room.name;
  const L = 'PF2EDC.Dungeon.Retreat.';
  if (!room || !Object.hasOwn(ROOM_KIND_WORDS, room.kind)) return i18n.localize(`${L}PreviousRoom`);
  const kind = i18n.localize(`${L}RoomKind.${room.kind}`);
  const rank = state.layoutPositionByRoomId?.[roomId]?.rank;
  return Number.isFinite(rank) ? i18n.format(`${L}RoomLabel`, { kind, rank }) : i18n.format(`${L}RoomLabelNoRank`, { kind });
}

/** #574: the Foundry-UI name of a room's floor-art Tile, so it is identifiable in the Tiles directory / on hover:
 * 'Combat (rank 2, col 1)', or 'Goal (rank 5, col 0)' for the goal room. Without a finite rank AND col it is just
 * the kind word; an unknown/missing kind reads 'Room'. `i18n` ({localize, format}) defaults to English. */
export function roomTileName(kind, rank, col, isGoal = false, i18n = ENGLISH_I18N) {
  const L = 'PF2EDC.Dungeon.RoomTile.';
  const label = isGoal
    ? i18n.localize(`${L}Goal`)
    : Object.hasOwn(ROOM_KIND_WORDS, kind) ? i18n.localize(`${L}Kind.${kind}`) : i18n.localize(`${L}Generic`);
  return Number.isFinite(rank) && Number.isFinite(col) ? i18n.format(`${L}Name`, { kind: label, rank, col }) : label;
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

/** #439 R4: which retreat controls the tracker shows. `canRetreat` is false until
 * the stub door has been opened (canRetreat's 'undiscovered' reason), so the button
 * never leaks a stub; a room with no stub and no forward edge (#585: every exit walled)
 * has nothing to discover, so it offers Turn back as soon as it is judged; the GM-only repair shows when the path is missing or its tail
 * is not the current room. Pre-v3 runs (no retreatVersion) show nothing. */
export function retreatUiFor(state, { isGM = false, combatActive = false } = {}) {
  if (!(state?.retreatVersion >= 1)) return { canRetreat: false, canResetRetreatPath: false };
  const path = state.retreatPath;
  const broken = !Array.isArray(path) || path[path.length - 1] !== state.currentRoomId;
  return { canRetreat: canRetreat(state, { combatActive }).ok, canResetRetreatPath: isGM && broken };
}

/** #439 R4: what the chat-card button binds to; null when the message is not a retreat card. */
export function retreatCardActionFor(message, { isGM = false, hostUserId = null, userId = null } = {}) {
  const card = message?.flags?.['pf2e-dungeon-crawl']?.retreatCard;
  if (!card?.sceneId) return null;
  return { sceneId: card.sceneId, enabled: !!isGM || (!!hostUserId && hostUserId === userId) };
}

/** #439: the run-state fields a new run carries; empty for layoutVersion < 3 so
 * older runs stay byte-identical. */
export function retreatStateFor(layoutVersion) {
  if (!(layoutVersion >= 3)) return {};
  return { retreatVersion: RETREAT_VERSION, retreatPath: ['room-entry'], stubsOpened: {}, retreats: [] };
}
