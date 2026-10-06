// #439 R3: scene layer for retreat (teleport option, stub-door and revisit branches,
// retreatToFork, relay actions). Separate file from dungeon-scene.test.mjs because it
// vi.mock()s startCombatForRoom, which would leak into that file's tests.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const combatStarts = [];
vi.mock('../scripts/dungeon-combat.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, startCombatForRoom: async (...args) => { combatStarts.push(args); } };
});

globalThis.canvas = {};
globalThis.foundry = {
  applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (Base) => Base } },
  utils: { escapeHTML: (s) => String(s) },
};
const { roomKindAllowsTrackerAutoOpen, moveTokensToRoom, handleDungeonDoorOpened, retreatToFork, announceNoWayForward, undoRoomEntry } = await import('../scripts/dungeon-scene.mjs');
const { replaceRunState, getRunState } = await import('../scripts/dungeon-runner.mjs');
const { DUNGEON_ACTIONS } = await import('../scripts/dungeon-remote.mjs');
const { isAuthorizedRequest } = await import('../scripts/dungeon-permissions.mjs');

const { registerGenerator } = await import('../scripts/generator-registry.mjs');
const { DefaultGenerator } = await import('../scripts/default-generator.mjs');

const MODULE_ID = 'pf2e-dungeon-crawl';
const SID = 's';

function makeScene({ walls = [], tokens = [], log = [], failMove = false } = {}) {
  // Like Foundry's collection: iterable / find()-able, plus a Map-style get (#175's
  // sibling re-lock walks scene.walls).
  const wallList = Object.assign([...walls], { get: (id) => walls.find((w) => w.id === id) });
  const scene = {
    id: SID,
    walls: wallList,
    tokens: Object.assign([...tokens], {}),
    updates: [],
    async updateEmbeddedDocuments(type, updates, options) {
      log.push('move');
      if (failMove) throw new Error('boom');
      scene.updates.push({ type, updates, options });
    },
  };
  return scene;
}
const wall = (id, flags) => ({ id, getFlag: (m, k) => (m === MODULE_ID ? flags[k] : undefined) });
const token = (id, actorId, extra = {}) => ({
  id, actor: { id: actorId }, hidden: false, getFlag: () => undefined, ...extra,
});

function v3State(over = {}) {
  const rooms = Object.fromEntries(['room-entry', 'f', 'a', 'b', 'd', 'g'].map((id) => [id, { id, isGoal: id === 'g', kind: 'combat', name: `Room ${id}` }]));
  return {
    seed: 'seed', rooms,
    edges: { 'room-entry': ['f'], f: ['a', 'b'], a: ['d'], d: [], b: ['g'], g: [] },
    hiddenEdges: {}, stubEdges: { d: ['g'] }, layoutVersion: 3, retreatVersion: 1,
    layoutPositionByRoomId: { 'room-entry': { rank: 0, col: 0 }, f: { rank: 1, col: 0 }, a: { rank: 2, col: 0 }, b: { rank: 2, col: 1 }, d: { rank: 3, col: 0 }, g: { rank: 3, col: 1 } },
    history: [{ roomId: 'f' }, { roomId: 'a' }, { roomId: 'd' }],
    currentRoomId: 'd', retreatPath: ['room-entry', 'f', 'a', 'd'],
    stubsOpened: {}, retreats: [], completed: false, lastAutoEntry: null,
    aiControlledActorIds: [], marchingOrder: [], ...over,
  };
}

let store, chat, warns, scenes, settingsValues;
function installGlobals({ isGM = true, combats = [], party = [] } = {}) {
  store = { dungeonRuns: {} };
  chat = [];
  warns = [];
  settingsValues = { autoRetreat: false };
  scenes = new Map();
  globalThis.game = {
    user: { isGM },
    settings: {
      get: (m, k) => (k in store ? store[k] : settingsValues[k]),
      set: async (m, k, v) => { store = { ...store, [k]: v }; },
    },
    i18n: { localize: (k) => k, format: (k, d) => `${k}|${JSON.stringify(d)}` },
    scenes: { get: (id) => scenes.get(id) },
    combats,
    actors: { party: { members: party.map((id) => ({ id })) } },
  };
  globalThis.CONST = { WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 } };
  globalThis.ChatMessage = { create: async (d) => { chat.push(d); } };
  globalThis.ui = { notifications: { warn: (m) => warns.push(m), error: () => {} } };
}
async function seed(state) { await replaceRunState(SID, state); }

beforeEach(() => { combatStarts.length = 0; });

describe('moveTokensToRoom teleport option (#439 R3.1)', () => {
  it('passes { teleport: true } when asked, undefined otherwise', async () => {
    const scene = makeScene();
    await moveTokensToRoom(scene, ['t1'], 'r', 0, 0, 'seed', { teleport: true });
    expect(scene.updates[0].options).toEqual({ teleport: true });
    await moveTokensToRoom(scene, ['t1'], 'r', 0, 0, 'seed');
    expect(scene.updates[1].options).toBeUndefined();
  });
});

describe('handleDungeonDoorOpened stub and revisit branches (#439 R3.2)', () => {
  const stubWall = wall('w-stub', { dungeonStubDoorFor: 'g', dungeonDoorFromRoomId: 'd' });
  beforeEach(() => installGlobals());

  it('stub door: records discovery, posts flavor + one card, never advances', async () => {
    const scene = makeScene({ walls: [stubWall] });
    scenes.set(SID, scene);
    await seed(v3State());
    const res = await handleDungeonDoorOpened(SID, 'w-stub');
    expect(res.autoOpenTracker).toBe(true);
    const after = getRunState(SID);
    expect(after.stubsOpened['d->g']).toBeTruthy();
    expect(after.currentRoomId).toBe('d');
    expect(after.retreatPath).toEqual(['room-entry', 'f', 'a', 'd']);
    expect(chat).toHaveLength(2);
    expect(chat[0].content).toBe('PF2EDC.Dungeon.Retreat.StubFlavor');
    expect(chat[1].flags[MODULE_ID].retreatCard).toEqual({ sceneId: SID });
    expect(chat[1].content).toContain('data-pf2edc-retreat');
    expect(scene.updates).toHaveLength(0);
  });

  it('stub door opened a second time posts nothing new', async () => {
    scenes.set(SID, makeScene({ walls: [stubWall] }));
    await seed(v3State());
    await handleDungeonDoorOpened(SID, 'w-stub');
    chat.length = 0;
    await handleDungeonDoorOpened(SID, 'w-stub');
    expect(chat).toHaveLength(0);
  });

  it("a stub door of a room that is not current is ignored", async () => {
    scenes.set(SID, makeScene({ walls: [stubWall] }));
    const st = v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'], history: [{ roomId: 'f' }] });
    await seed(st);
    const res = await handleDungeonDoorOpened(SID, 'w-stub');
    expect(res.autoOpenTracker).toBe(false);
    expect(getRunState(SID)).toEqual(st);
    expect(chat).toHaveLength(0);
  });

  it('a stub door with no retreat target posts flavor but no card', async () => {
    scenes.set(SID, makeScene({ walls: [stubWall] }));
    await seed(v3State({ currentRoomId: 'd', retreatPath: ['d'], history: [{ roomId: 'd' }] }));
    await handleDungeonDoorOpened(SID, 'w-stub');
    expect(chat).toHaveLength(1);
  });

  it('autoRetreat: discovery calls retreatToFork instead of posting a card', async () => {
    scenes.set(SID, makeScene({ walls: [stubWall] }));
    settingsValues.autoRetreat = true;
    await seed(v3State());
    const calls = [];
    await handleDungeonDoorOpened(SID, 'w-stub', { retreatToFork: async (id) => { calls.push(id); } });
    expect(calls).toEqual([SID]);
    expect(chat.map((c) => c.content)).toEqual(['PF2EDC.Dungeon.Retreat.StubFlavor']);
  });

  it('REVIEW FOCUS 1: revisiting a judged combat room does not reveal or start its fight', async () => {
    const hiddenTok = token('mon', 'monster', { hidden: true, getFlag: (m, k) => (k === 'dungeonSlot' ? 'a' : undefined) });
    const revealA = wall('w-a', { dungeonRevealDoorForSlot: 'a' });
    const scene = makeScene({ walls: [revealA], tokens: [hiddenTok] });
    scenes.set(SID, scene);
    // post-retreat state: party at fork f, a is judged
    await seed(v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'], lastAutoEntry: { roomId: 'x' } }));
    const res = await handleDungeonDoorOpened(SID, 'w-a');
    expect(res.autoOpenTracker).toBe(false);
    expect(combatStarts).toHaveLength(0);
    expect(scene.updates).toHaveLength(0);
    expect(hiddenTok.hidden).toBe(true);
    const after = getRunState(SID);
    expect(after.currentRoomId).toBe('a');
    expect(after.lastAutoEntry).toBeNull();
  });

  it('first entry of an unjudged combat room still reveals and starts combat', async () => {
    const hiddenTok = token('mon', 'monster', { hidden: true, getFlag: (m, k) => (k === 'dungeonSlot' ? 'b' : undefined) });
    const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
    const scene = makeScene({ walls: [revealB], tokens: [hiddenTok] });
    scenes.set(SID, scene);
    await seed(v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'] }));
    await handleDungeonDoorOpened(SID, 'w-b');
    expect(combatStarts).toHaveLength(1);
    expect(scene.updates[0].updates).toEqual([{ _id: 'mon', hidden: false }]);
    expect(getRunState(SID).currentRoomId).toBe('b');
  });

  it.each(['treasure', 'skill_challenge', 'puzzle'])(
    '#771: a %s room does not auto-open the tracker',
    async (kind) => {
      registerGenerator(DefaultGenerator);
      const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
      scenes.set(SID, makeScene({ walls: [revealB] }));
      const state = v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'] });
      state.rooms.b = { ...state.rooms.b, kind, outcomeSlotId: null };
      await seed(state);
      const res = await handleDungeonDoorOpened(SID, 'w-b');
      expect(res.autoOpenTracker).toBe(false);
    },
  );

  it.each(['narrative', 'safe_rest'])(
    '#771: a %s room still auto-opens the tracker',
    async (kind) => {
      registerGenerator(DefaultGenerator);
      const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
      scenes.set(SID, makeScene({ walls: [revealB] }));
      const state = v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'] });
      state.rooms.b = { ...state.rooms.b, kind, outcomeSlotId: null };
      await seed(state);
      const res = await handleDungeonDoorOpened(SID, 'w-b');
      expect(res.autoOpenTracker).toBe(true);
    },
  );
});

describe('retreatToFork (#439 R3.3)', () => {
  const party = ['human', 'ai1', 'ai2'];
  function setup({ failMove = false, combats = [] } = {}) {
    installGlobals({ party, combats });
    const log = [];
    const scene = makeScene({
      log, failMove,
      tokens: [token('t-ai2', 'ai2'), token('t-ai1', 'ai1'), token('t-h', 'human'), token('t-other', 'stranger')],
    });
    scenes.set(SID, scene);
    const origSet = globalThis.game.settings.set;
    globalThis.game.settings.set = async (...a) => { log.push('persist'); return origSet(...a); };
    return { scene, log };
  }
  const dead = (over = {}) => v3State({ stubsOpened: { 'd->g': 1 }, aiControlledActorIds: ['ai1', 'ai2'], marchingOrder: ['ai1', 'ai2'], ...over });

  it('moves tokens with teleport:true FIRST, then persists, then posts a line', async () => {
    const { scene, log } = setup();
    await seed(dead());
    log.length = 0;
    const res = await retreatToFork(SID);
    expect(res).toEqual({ ok: true });
    expect(scene.updates[0].options).toEqual({ teleport: true });
    expect(log).toEqual(['move', 'persist']);
    const after = getRunState(SID);
    expect(after.currentRoomId).toBe('f');
    expect(after.retreatPath).toEqual(['room-entry', 'f']);
    expect(after.retreats).toHaveLength(1);
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toContain('PF2EDC.Dungeon.Retreat.Turned');
  });

  it('a move that throws leaves state unchanged, no chat, no retreats entry', async () => {
    setup({ failMove: true });
    const st = dead();
    await seed(st);
    await expect(retreatToFork(SID)).rejects.toThrow('boom');
    expect(getRunState(SID)).toEqual(st);
    expect(chat).toHaveLength(0);
  });

  it('REVIEW FOCUS 2: a double press yields exactly one retreats entry', async () => {
    setup();
    await seed(dead());
    const [r1, r2] = await Promise.all([retreatToFork(SID), retreatToFork(SID)]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    const after = getRunState(SID);
    expect(after.retreats).toHaveLength(1);
    expect(after.currentRoomId).toBe('f');
    expect(chat).toHaveLength(1);
  });

  it('REVIEW FOCUS 5: refuses with an active combat, no token move, no state change', async () => {
    const { scene } = setup({ combats: [{ scene: { id: SID }, started: true }] });
    const st = dead();
    await seed(st);
    const res = await retreatToFork(SID);
    expect(res).toEqual({ ok: false, reason: 'combat' });
    expect(scene.updates).toHaveLength(0);
    expect(warns).toEqual(['PF2EDC.Dungeon.Retreat.Refused.combat']);
    expect(getRunState(SID)).toEqual(st);
  });

  it('moves party tokens only, humans first then marching order', async () => {
    const { scene } = setup();
    await seed(dead());
    await retreatToFork(SID);
    expect(scene.updates[0].updates.map((u) => u._id)).toEqual(['t-h', 't-ai1', 't-ai2']);
  });
});

describe('legacy runs are untouched (#439)', () => {
  it('a run without retreatVersion keeps the first-entry path even for a judged room', async () => {
    installGlobals();
    const revealA = wall('w-a', { dungeonRevealDoorForSlot: 'a' });
    scenes.set(SID, makeScene({ walls: [revealA] }));
    const legacy = v3State({ currentRoomId: 'f', history: [{ roomId: 'f' }, { roomId: 'a' }], layoutVersion: 2 });
    delete legacy.retreatVersion;
    await seed(legacy);
    await handleDungeonDoorOpened(SID, 'w-a');
    expect(combatStarts).toHaveLength(1);
  });
});

describe('relay actions (#439 R3.3)', () => {
  it('retreat and resetRetreatPath are in the action table', () => {
    expect(typeof DUNGEON_ACTIONS.retreat).toBe('function');
    expect(typeof DUNGEON_ACTIONS.resetRetreatPath).toBe('function');
  });
  it('resetRetreatPath routes to the runner repair', async () => {
    installGlobals();
    await seed(v3State({ retreatPath: undefined }));
    await DUNGEON_ACTIONS.resetRetreatPath({ sceneId: SID });
    expect(getRunState(SID).retreatPath).toEqual(['room-entry', 'f', 'a', 'd']);
  });
  it('retreat routes to retreatToFork', async () => {
    installGlobals({ party: [] });
    scenes.set(SID, makeScene());
    await seed(v3State({ stubsOpened: { 'd->g': 1 } }));
    expect(await DUNGEON_ACTIONS.retreat({ sceneId: SID })).toEqual({ ok: true });
  });
  it("isAuthorizedRequest('retreat') is true only for the host", () => {
    const run = { hostUserId: 'u1' };
    expect(isAuthorizedRequest('retreat', 'u1', run)).toBe(true);
    expect(isAuthorizedRequest('retreat', 'u2', run)).toBe(false);
    expect(isAuthorizedRequest('retreat', undefined, run)).toBe(false);
  });
});

describe('walled dead end: flavor line and Turn back (#585)', () => {
  beforeEach(() => installGlobals());
  // f -> w (all children walled: edges.w empty, no stub), f -> b ; party at w, judged.
  const walledState = (over = {}) => v3State({
    edges: { 'room-entry': ['f'], f: ['w', 'b'], w: [], b: ['g'], g: [] },
    stubEdges: {}, walledEdges: { w: ['g'] }, deadEdgeWalls: true,
    history: [{ roomId: 'f' }, { roomId: 'w' }], currentRoomId: 'w', retreatPath: ['room-entry', 'f', 'w'],
    rooms: Object.fromEntries(['room-entry', 'f', 'w', 'b', 'g'].map((id) => [id, { id, isGoal: id === 'g', kind: 'combat', name: `Room ${id}` }])),
    layoutPositionByRoomId: { 'room-entry': { rank: 0, col: 0 }, f: { rank: 1, col: 0 }, w: { rank: 2, col: 0 }, b: { rank: 2, col: 1 }, g: { rank: 3, col: 1 } },
    ...over,
  });

  it('posts the one flavor line, then one Turn back card (no rubble wording)', async () => {
    scenes.set(SID, makeScene());
    await announceNoWayForward(scenes.get(SID), walledState());
    expect(chat).toHaveLength(2);
    expect(chat[0].content).toBe('PF2EDC.Dungeon.Retreat.NoWayForward');
    expect(chat[1].flags[MODULE_ID].retreatCard).toEqual({ sceneId: SID });
    expect(chat[1].content).toContain('data-pf2edc-retreat');
    expect(chat[1].content).toContain('PF2EDC.Dungeon.Retreat.CardNoWay');
    expect(chat[1].content).not.toContain('PF2EDC.Dungeon.Retreat.Card|');
  });

  it('autoRetreat: flavor line, then retreatToFork instead of a card', async () => {
    scenes.set(SID, makeScene());
    settingsValues.autoRetreat = true;
    const calls = [];
    await announceNoWayForward(scenes.get(SID), walledState(), { retreatToFork: async (id) => { calls.push(id); } });
    expect(calls).toEqual([SID]);
    expect(chat.map((c) => c.content)).toEqual(['PF2EDC.Dungeon.Retreat.NoWayForward']);
  });

  it('no target: the flavor line only', async () => {
    scenes.set(SID, makeScene());
    await announceNoWayForward(scenes.get(SID), walledState({ retreatPath: ['w'], history: [{ roomId: 'w' }] }));
    expect(chat.map((c) => c.content)).toEqual(['PF2EDC.Dungeon.Retreat.NoWayForward']);
  });

  it('says nothing for a room with a way forward, a stub, or a run created before the walls', async () => {
    scenes.set(SID, makeScene());
    await announceNoWayForward(scenes.get(SID), walledState({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'] }));
    await announceNoWayForward(scenes.get(SID), walledState({ stubEdges: { w: ['g'] } }));
    await announceNoWayForward(scenes.get(SID), walledState({ deadEdgeWalls: undefined }));
    expect(chat).toHaveLength(0);
  });

  it('retreatToFork from a walled dead end turns back with the no-rubble line', async () => {
    installGlobals({ party: [] });
    scenes.set(SID, makeScene());
    await seed(walledState());
    expect(await retreatToFork(SID)).toEqual({ ok: true });
    expect(getRunState(SID).currentRoomId).toBe('f');
    expect(chat[0].content).toContain('PF2EDC.Dungeon.Retreat.TurnedNoWay');
  });

  it('a stub dead end still turns back with the rubble line', async () => {
    installGlobals({ party: [] });
    scenes.set(SID, makeScene());
    await seed(v3State({ stubsOpened: { 'd->g': 1 }, deadEdgeWalls: true }));
    await retreatToFork(SID);
    expect(chat[0].content).toContain('PF2EDC.Dungeon.Retreat.Turned|');
  });

  it('names an unnamed target room by kind and rank, never its raw id (#577)', async () => {
    installGlobals({ party: [] });
    scenes.set(SID, makeScene());
    const st = v3State({ stubsOpened: { 'd->g': 1 }, deadEdgeWalls: true });
    for (const r of Object.values(st.rooms)) delete r.name;
    st.rooms.f.kind = 'treasure';
    await seed(st);
    await retreatToFork(SID);
    expect(chat[0].content).toContain('PF2EDC.Dungeon.Retreat.RoomLabel|');
    expect(chat[0].content).toContain('RoomKind.treasure');
    expect(chat[0].content).not.toContain('"target":"f"');
  });
});

describe('a rest room whose every exit was walled announces the dead end (#585)', () => {
  it('opening its reveal door resolves it and posts the flavor line and the Turn back card', async () => {
    installGlobals();
    registerGenerator(DefaultGenerator);
    const reveal = wall('w-r', { dungeonRevealDoorForSlot: 'r' });
    const restScene = makeScene({ walls: [reveal] });
    // unlockDoorsFromRoom walks scene.walls as a collection of documents (find / for..of), like Foundry's.
    restScene.walls = Object.assign([reveal], { get: (id) => (id === 'w-r' ? reveal : undefined) });
    scenes.set(SID, restScene);
    const rooms = Object.fromEntries(['room-entry', 'f', 'r', 'b', 'g'].map((id) => [id, {
      id, isGoal: id === 'g', kind: id === 'r' ? 'safe_rest' : 'combat', name: `Room ${id}`, outcomeSlotId: null,
    }]));
    await seed(v3State({
      rooms, edges: { 'room-entry': ['f'], f: ['r', 'b'], r: [], b: ['g'], g: [] }, stubEdges: {}, walledEdges: { r: ['g'] },
      deadEdgeWalls: true, hiddenEdges: {},
      layoutPositionByRoomId: { 'room-entry': { rank: 0, col: 0 }, f: { rank: 1, col: 0 }, r: { rank: 2, col: 0 }, b: { rank: 2, col: 1 }, g: { rank: 3, col: 1 } },
      history: [{ roomId: 'f' }], currentRoomId: 'f', retreatPath: ['room-entry', 'f'],
    }));
    await handleDungeonDoorOpened(SID, 'w-r');
    const texts = chat.map((c) => c.content);
    expect(texts[0]).toBe('PF2EDC.Dungeon.Retreat.NoWayForward');
    expect(chat[1].flags[MODULE_ID].retreatCard).toEqual({ sceneId: SID });
    expect(getRunState(SID).currentRoomId).toBe('r');
  });

  // #613: the rest room triggers PF2e's real Rest for the Night for the party.
  async function setUpRestRoom() {
    installGlobals({ party: ['pc1', 'pc2'] });
    globalThis.game.pf2e = { actions: { restForTheNight: vi.fn().mockResolvedValue([]) } };
    registerGenerator(DefaultGenerator);
    const reveal = wall('w-r', { dungeonRevealDoorForSlot: 'r' });
    const restScene = makeScene({ walls: [reveal] });
    restScene.walls = Object.assign([reveal], { get: (id) => (id === 'w-r' ? reveal : undefined) });
    scenes.set(SID, restScene);
    const rooms = Object.fromEntries(['room-entry', 'f', 'r', 'b', 'g'].map((id) => [id, {
      id, isGoal: id === 'g', kind: id === 'r' ? 'safe_rest' : 'combat', name: `Room ${id}`, outcomeSlotId: null,
    }]));
    await seed(v3State({
      rooms, edges: { 'room-entry': ['f'], f: ['r', 'b'], r: [], b: ['g'], g: [] }, stubEdges: {}, walledEdges: { r: ['g'] },
      deadEdgeWalls: true, hiddenEdges: {},
      layoutPositionByRoomId: { 'room-entry': { rank: 0, col: 0 }, f: { rank: 1, col: 0 }, r: { rank: 2, col: 0 }, b: { rank: 2, col: 1 }, g: { rank: 3, col: 1 } },
      history: [{ roomId: 'f' }], currentRoomId: 'f', retreatPath: ['room-entry', 'f'],
    }));
  }

  it('calls PF2e Rest for the Night once for the party (skipDialog) and still resolves the room (#613)', async () => {
    await setUpRestRoom();
    await handleDungeonDoorOpened(SID, 'w-r');
    expect(game.pf2e.actions.restForTheNight).toHaveBeenCalledTimes(1);
    expect(game.pf2e.actions.restForTheNight).toHaveBeenCalledWith({
      actors: game.actors.party.members,
      skipDialog: true,
    });
    expect(getRunState(SID).currentRoomId).toBe('r');
  });

  it('a failing Rest for the Night is reported but never blocks the room (#613)', async () => {
    await setUpRestRoom();
    game.pf2e.actions.restForTheNight.mockRejectedValue(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notifyError = vi.fn();
    globalThis.ui.notifications.error = notifyError;
    try {
      await expect(handleDungeonDoorOpened(SID, 'w-r')).resolves.toBeDefined();
      expect(notifyError).toHaveBeenCalledWith('PF2EDC.Dungeon.RestForTheNightFailedError');
      expect(errorSpy).toHaveBeenCalled();
      expect(getRunState(SID).currentRoomId).toBe('r');
      expect(chat.map((c) => c.content)).toContain('PF2EDC.Dungeon.Retreat.NoWayForward');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('unchosen sibling gate doors lock/unlock with the path (#175)', () => {
  const LOCKED = 2; // CONST.WALL_DOOR_STATES.LOCKED
  const CLOSED = 0;
  // A gate (progress) door from `from` into `to`, with an update spy.
  const gate = (id, from, to) => {
    const w = wall(id, { dungeonDoorToRoomId: to, dungeonDoorFromRoomId: from });
    w.update = vi.fn(async () => {});
    return w;
  };
  const hiddenGate = (id, from, to) => {
    const w = wall(id, { dungeonDoorToRoomId: to, dungeonDoorFromRoomId: from, dungeonHiddenDoorForEdge: `${from}->${to}` });
    w.update = vi.fn(async () => {});
    return w;
  };
  const stub = (id, from, to) => {
    const w = wall(id, { dungeonStubDoorFor: to, dungeonDoorFromRoomId: from });
    w.update = vi.fn(async () => {});
    return w;
  };
  const sceneWith = (walls, extra = {}) => makeScene({ walls, ...extra });
  const states = (w) => w.update.mock.calls.map(([c]) => c.ds);
  beforeEach(() => installGlobals({ party: ['human'] }));

  it('advancing into one child re-locks the other open child of the same parent', async () => {
    const gA = gate('g-a', 'f', 'a');
    const gB = gate('g-b', 'f', 'b');
    const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
    scenes.set(SID, sceneWith([gA, gB, revealB]));
    await seed(v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'], history: [{ roomId: 'f' }] }));
    await handleDungeonDoorOpened(SID, 'w-b');
    expect(states(gA)).toEqual([LOCKED]);
    expect(gB.update).not.toHaveBeenCalled();
    expect(getRunState(SID).currentRoomId).toBe('b');
  });

  it('leaves a hidden sibling door and the parent stub doors alone', async () => {
    const gA = gate('g-a', 'f', 'a');
    const hidden = hiddenGate('g-h', 'f', 'h');
    const stubDoor = stub('s-1', 'f', 'g');
    const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
    scenes.set(SID, sceneWith([gA, hidden, stubDoor, revealB]));
    await seed(v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'], history: [{ roomId: 'f' }] }));
    await handleDungeonDoorOpened(SID, 'w-b');
    expect(states(gA)).toEqual([LOCKED]);
    expect(hidden.update).not.toHaveBeenCalled();
    expect(stubDoor.update).not.toHaveBeenCalled();
  });

  it('does not re-lock a sibling that was already judged', async () => {
    const gA = gate('g-a', 'f', 'a');
    const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
    scenes.set(SID, sceneWith([gA, revealB]));
    // a was entered and judged before a retreat brought the party back to f
    await seed(v3State({ currentRoomId: 'f', retreatPath: ['room-entry', 'f'] }));
    await handleDungeonDoorOpened(SID, 'w-b');
    expect(gA.update).not.toHaveBeenCalled();
  });

  it('retreating to a fork re-unlocks only that fork\'s still-open children', async () => {
    const gA = gate('g-a', 'f', 'a'); // a is judged: stays locked
    const gB = gate('g-b', 'f', 'b'); // b is open: re-unlocked
    scenes.set(SID, sceneWith([gA, gB], { tokens: [token('t-h', 'human')] }));
    await seed(v3State({ stubsOpened: { 'd->g': 1 } }));
    const res = await retreatToFork(SID);
    expect(res).toEqual({ ok: true });
    expect(states(gB)).toEqual([CLOSED]);
    expect(gA.update).not.toHaveBeenCalled();
  });

  it('undoing an entry re-unlocks the siblings the entry had re-locked', async () => {
    const gA = gate('g-a', 'f', 'a');
    const gB = gate('g-b', 'f', 'b');
    scenes.set(SID, sceneWith([gA, gB], { tokens: [token('t-h', 'human')] }));
    await seed(v3State({
      currentRoomId: 'b', retreatPath: ['room-entry', 'f', 'b'], history: [{ roomId: 'f' }],
      lastAutoEntry: { roomId: 'b', fromRoomId: 'f', toRoomId: 'b', revealedTokenIds: [] },
    }));
    await undoRoomEntry(SID);
    expect(states(gB)).toEqual([LOCKED]); // relockDoorFromRoom: the entered door
    expect(states(gA)).toEqual([CLOSED]); // sibling re-opened
    expect(getRunState(SID).currentRoomId).toBe('f');
  });

  it('a legacy run without a retreatPath still re-locks siblings but never the entered room', async () => {
    const gA = gate('g-a', 'f', 'a');
    const gB = gate('g-b', 'f', 'b');
    const revealB = wall('w-b', { dungeonRevealDoorForSlot: 'b' });
    scenes.set(SID, sceneWith([gA, gB, revealB]));
    const legacy = v3State({ currentRoomId: 'f', history: [{ roomId: 'f' }], layoutVersion: 2 });
    delete legacy.retreatVersion;
    delete legacy.retreatPath;
    await seed(legacy);
    await handleDungeonDoorOpened(SID, 'w-b');
    expect(states(gA)).toEqual([LOCKED]);
    expect(gB.update).not.toHaveBeenCalled();
  });
});

describe('roomKindAllowsTrackerAutoOpen (#845)', () => {
  it.each(['combat', 'treasure', 'skill_challenge', 'puzzle'])('excludes %s', (kind) => {
    expect(roomKindAllowsTrackerAutoOpen(kind)).toBe(false);
  });

  it.each(['narrative', 'safe_rest', 'safe_entry', 'trap', undefined, null])('allows %s', (kind) => {
    expect(roomKindAllowsTrackerAutoOpen(kind)).toBe(true);
  });
});
