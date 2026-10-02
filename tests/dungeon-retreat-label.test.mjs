// #577: readable room labels in retreat text (generated rooms carry no name).
import { describe, it, expect } from 'vitest';
import { roomDisplayLabel } from '../scripts/dungeon-retreat.mjs';

describe('roomDisplayLabel (#577)', () => {
  const st = (room, pos) => ({ rooms: { r: room }, layoutPositionByRoomId: pos ? { r: pos } : {} });
  const KINDS = {
    safe_entry: 'entry', safe_rest: 'rest', skill_challenge: 'skill challenge', combat: 'combat',
    trap: 'trap', puzzle: 'puzzle', narrative: 'narrative', treasure: 'treasure',
  };
  it.each(Object.entries(KINDS))('names a %s room with its rank (default English)', (kind, word) => {
    expect(roomDisplayLabel(st({ id: 'r', kind }, { rank: 4, col: 1 }), 'r')).toBe(`the ${word} room (rank 4)`);
  });
  it('omits the rank when the layout position is unknown', () => {
    expect(roomDisplayLabel(st({ id: 'r', kind: 'treasure' }), 'r')).toBe('the treasure room');
  });
  it('prefers an explicit room name', () => {
    expect(roomDisplayLabel(st({ id: 'r', kind: 'combat', name: 'The Pit' }, { rank: 2, col: 0 }), 'r')).toBe('The Pit');
  });
  it('falls back to a generic label for a missing room, unknown kind, or bad state, never the raw id', () => {
    expect(roomDisplayLabel(st({ id: 'r', kind: 'combat' }), 'zzz-id')).toBe('the previous room');
    expect(roomDisplayLabel(st({ id: 'r', kind: 'weird' }, { rank: 1, col: 0 }), 'r')).toBe('the previous room');
    expect(roomDisplayLabel({}, 'room-room-entry-0-0')).toBe('the previous room');
    expect(roomDisplayLabel(undefined, undefined)).toBe('the previous room');
  });
  it('routes through an injected i18n for localisation', () => {
    const i18n = { localize: (k) => `L:${k}`, format: (k, d) => `${k}|${d.kind}|${d.rank ?? ''}` };
    expect(roomDisplayLabel(st({ id: 'r', kind: 'trap' }, { rank: 3, col: 0 }), 'r', i18n))
      .toBe('PF2EDC.Dungeon.Retreat.RoomLabel|L:PF2EDC.Dungeon.Retreat.RoomKind.trap|3');
    expect(roomDisplayLabel(st({ id: 'r', kind: 'trap' }), 'r', i18n))
      .toBe('PF2EDC.Dungeon.Retreat.RoomLabelNoRank|L:PF2EDC.Dungeon.Retreat.RoomKind.trap|');
    expect(roomDisplayLabel({}, 'x', i18n)).toBe('L:PF2EDC.Dungeon.Retreat.PreviousRoom');
  });
});
