// tests/dungeon-retreat.test.mjs
import { describe, it, expect } from 'vitest';
import {
  RETREAT_VERSION, spentRooms, openChildren, isDeadEnd, retreatTargetFor, canRetreat,
  withEntry, withUndoneEntry, withRetreat, withStubOpened, rebuildRetreatPath, retreatStateFor,
  retreatUiFor, retreatCardActionFor,
} from '../scripts/dungeon-retreat.mjs';

// entry -> f ; f -> a, b ; a -> d (dead end: its only forward edge is a stub to g) ; b -> g ; g goal
function fixture(over = {}) {
  const rooms = Object.fromEntries(['room-entry', 'f', 'a', 'b', 'd', 'g'].map((id) => [id, { id, isGoal: id === 'g' }]));
  return {
    rooms,
    edges: { 'room-entry': ['f'], f: ['a', 'b'], a: ['d'], d: [], b: ['g'], g: [] },
    stubEdges: { d: ['g'] },
    history: [{ roomId: 'f' }, { roomId: 'a' }, { roomId: 'd' }],
    currentRoomId: 'd',
    retreatPath: ['room-entry', 'f', 'a', 'd'],
    retreatVersion: 1, stubsOpened: {}, retreats: [], completed: false,
    ...over,
  };
}

describe('dungeon-retreat rules', () => {
  it('exports version 1', () => expect(RETREAT_VERSION).toBe(1));
  it('spentRooms is judged rooms plus the path', () => {
    expect([...spentRooms(fixture())].sort()).toEqual(['a', 'd', 'f', 'room-entry']);
  });
  it('openChildren excludes spent children (a merge child already visited is spent)', () => {
    expect(openChildren(fixture(), 'f')).toEqual(['b']);
    expect(openChildren(fixture(), 'a')).toEqual([]);
  });
  it('isDeadEnd needs a judged, non-goal room with no open child', () => {
    expect(isDeadEnd(fixture())).toBe(true);
    expect(isDeadEnd(fixture({ history: [{ roomId: 'f' }, { roomId: 'a' }] }))).toBe(false); // unjudged
    expect(isDeadEnd(fixture({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'] }))).toBe(false); // open child b
  });
  it('retreatTargetFor is the nearest fork on the path, skipping rooms without an open child', () => {
    expect(retreatTargetFor(fixture())).toBe('f'); // a has none, f has b
  });
  it('retreatTargetFor is null when no ancestor has an open child', () => {
    const s = fixture({ history: [...fixture().history, { roomId: 'b' }, { roomId: 'g' }] });
    expect(retreatTargetFor(s)).toBe(null);
  });
  it('a revealed hidden shortcut (an extra edge) makes the room a fork', () => {
    const s = fixture({ edges: { ...fixture().edges, a: ['d', 'g'] } });
    expect(retreatTargetFor(s)).toBe('a');
    expect(isDeadEnd(s)).toBe(true); // the CURRENT room d still has no open child
  });
});

describe('canRetreat reasons', () => {
  const opened = { 'd->g': true };
  it('ok once the stub door was opened', () => {
    expect(canRetreat(fixture({ stubsOpened: opened }))).toEqual({ ok: true, targetId: 'f' });
  });
  it.each([
    ['disabled', { retreatVersion: undefined }],
    ['completed', { completed: true, stubsOpened: opened }],
    ['unjudged', { history: [{ roomId: 'f' }, { roomId: 'a' }], stubsOpened: opened }],
    ['not-dead-end', { currentRoomId: 'f', retreatPath: ['room-entry', 'f'], stubsOpened: opened }],
    ['undiscovered', { stubsOpened: {} }],
  ])('refuses: %s', (reason, over) => {
    expect(canRetreat(fixture(over))).toEqual({ ok: false, reason });
  });
  it('refuses while a combat is active', () => {
    expect(canRetreat(fixture({ stubsOpened: opened }), { combatActive: true })).toEqual({ ok: false, reason: 'combat' });
  });
  it('a dead end with no stub (every child spent) needs no discovery', () => {
    const s = fixture({ stubEdges: {}, stubsOpened: {} });
    expect(canRetreat(s).ok).toBe(true);
  });
  it('no-target is reported, never thrown', () => {
    const s = fixture({ history: [...fixture().history, { roomId: 'b' }, { roomId: 'g' }], stubsOpened: opened });
    expect(canRetreat(s)).toEqual({ ok: false, reason: 'no-target' });
  });
});

describe('reducers', () => {
  it('withEntry pushes onto the path only when retreatVersion >= 1', () => {
    expect(withEntry(fixture(), 'x').retreatPath).toEqual(['room-entry', 'f', 'a', 'd', 'x']);
    const legacy = { currentRoomId: 'd', history: [] };
    expect(withEntry(legacy, 'x')).toBe(legacy);
  });
  it('withUndoneEntry pops only when the last path entry is that room', () => {
    const s = fixture({ retreatPath: ['room-entry', 'f', 'x'] });
    expect(withUndoneEntry(s, 'x').retreatPath).toEqual(['room-entry', 'f']);
    expect(withUndoneEntry(s, 'y').retreatPath).toEqual(['room-entry', 'f', 'x']);
  });
  it('withRetreat moves the room, truncates the path, logs, and clears lastAutoEntry', () => {
    const s = withRetreat(fixture({ stubsOpened: { 'd->g': true }, lastAutoEntry: { roomId: 'd' } }), 123);
    expect(s.currentRoomId).toBe('f');
    expect(s.retreatPath).toEqual(['room-entry', 'f']);
    expect(s.lastAutoEntry).toBe(null);
    expect(s.retreats).toEqual([{ fromRoomId: 'd', toRoomId: 'f', at: 123 }]);
    expect(s.history).toEqual(fixture().history); // never written
  });
  it('withRetreat throws when not allowed, and a second call after success throws (double press)', () => {
    expect(() => withRetreat(fixture(), 1)).toThrow(/undiscovered/);
    const once = withRetreat(fixture({ stubsOpened: { 'd->g': true } }), 1);
    expect(() => withRetreat(once, 2)).toThrow();
  });
  it('withStubOpened is idempotent', () => {
    const s = withStubOpened(fixture(), 'd', 'g');
    expect(s.stubsOpened).toEqual({ 'd->g': true });
    expect(withStubOpened(s, 'd', 'g')).toBe(s);
  });
  it('rebuildRetreatPath gives a valid chain entry..current, or null', () => {
    expect(rebuildRetreatPath(fixture({ retreatPath: undefined }))).toEqual(['room-entry', 'f', 'a', 'd']);
    expect(rebuildRetreatPath(fixture({ currentRoomId: 'nowhere' }))).toBe(null);
  });
});

describe('retreatStateFor (#439 R2)', () => {
  it('stamps only layoutVersion >= 3', () => {
    expect(retreatStateFor(2)).toEqual({});
    expect(retreatStateFor(undefined)).toEqual({});
    expect(retreatStateFor(3)).toEqual({ retreatVersion: 1, retreatPath: ['room-entry'], stubsOpened: {}, retreats: [] });
  });
});

describe('retreatUiFor (#439 R4.1)', () => {
  const discovered = () => fixture({ stubsOpened: { 'd->g': true } });
  it('offers Turn back at a discovered dead end, no repair', () => {
    expect(retreatUiFor(discovered(), { isGM: true })).toEqual({ canRetreat: true, canResetRetreatPath: false });
  });
  it('never leaks the stub: no button before the stub door is opened', () => {
    expect(retreatUiFor(fixture(), { isGM: true })).toEqual({ canRetreat: false, canResetRetreatPath: false });
    expect(retreatUiFor(fixture(), { isGM: false })).toEqual({ canRetreat: false, canResetRetreatPath: false });
  });
  it('a missing path disables Turn back and offers GM-only repair (Review Focus 3)', () => {
    const s = discovered(); delete s.retreatPath;
    expect(retreatUiFor(s, { isGM: true })).toEqual({ canRetreat: false, canResetRetreatPath: true });
    expect(retreatUiFor(s, { isGM: false })).toEqual({ canRetreat: false, canResetRetreatPath: false });
  });
  it('an inconsistent path (tail is not the current room) offers repair', () => {
    const s = discovered(); s.retreatPath = ['room-entry', 'f'];
    expect(retreatUiFor(s, { isGM: true }).canResetRetreatPath).toBe(true);
  });
  it('an active combat hides Turn back', () => {
    expect(retreatUiFor(discovered(), { isGM: true, combatActive: true }).canRetreat).toBe(false);
  });
  it('a pre-v3 / null state shows nothing', () => {
    expect(retreatUiFor(fixture({ retreatVersion: undefined }), { isGM: true })).toEqual({ canRetreat: false, canResetRetreatPath: false });
    expect(retreatUiFor(null, { isGM: true })).toEqual({ canRetreat: false, canResetRetreatPath: false });
  });
});

describe('retreatCardActionFor (#439 R4.2)', () => {
  const card = { flags: { 'pf2e-dungeon-crawl': { retreatCard: { sceneId: 's1' } } } };
  it('null without the card flag', () => {
    expect(retreatCardActionFor({ flags: {} }, { isGM: true })).toBe(null);
    expect(retreatCardActionFor(null, { isGM: true })).toBe(null);
  });
  it('enabled for a GM', () => {
    expect(retreatCardActionFor(card, { isGM: true })).toEqual({ sceneId: 's1', enabled: true });
  });
  it('enabled for the run host, disabled for another player', () => {
    expect(retreatCardActionFor(card, { isGM: false, hostUserId: 'u1', userId: 'u1' })).toEqual({ sceneId: 's1', enabled: true });
    expect(retreatCardActionFor(card, { isGM: false, hostUserId: 'u1', userId: 'u2' })).toEqual({ sceneId: 's1', enabled: false });
    expect(retreatCardActionFor(card, { isGM: false, userId: 'u2' })).toEqual({ sceneId: 's1', enabled: false });
  });
});
