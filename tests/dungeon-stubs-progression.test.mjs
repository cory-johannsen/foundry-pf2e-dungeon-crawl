// #427 Chunk 6, PR G2: stubs in run state and progression. A stub is a dead end, never a way forward:
// `state.edges` excludes it, `layoutEdges` keeps it, a revealed hidden-shortcut stub never joins `state.edges`.
import { describe, it, expect } from 'vitest';
import { revealTravelTimeEffect } from '../scripts/dungeon-deck.mjs';
import {
  markRoomOutcome, advanceToRoom, roomsToEagerlyBuild, replaceRunState, getRunState,
} from '../scripts/dungeon-runner.mjs';
import { registerGenerator } from '../scripts/generator-registry.mjs';
import { DefaultGenerator } from '../scripts/default-generator.mjs';
import { stubStateFor, NEW_RUN_STUBS_ENABLED, planStubsForLayout, applyStubsToEdges } from '../scripts/dungeon-layout.mjs';
import { unlockDoorsFromRoom, unsealHiddenDoorFromRoom } from '../scripts/dungeon-scene.mjs';
import { makeFakeScene, installFoundryStubs } from './helpers/scene-oracle.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { stubInputsFor } from './helpers/stub-sweep.mjs';

registerGenerator(DefaultGenerator);
const MODULE_ID = 'pf2e-dungeon-crawl';

describe('revealTravelTimeEffect with stubs', () => {
  const edges = { a: ['b'], b: [] };
  it('reveals a normal hidden edge exactly as before, with or without unrelated stubs', () => {
    const state = { edges, hiddenEdges: { a: ['m'] } };
    const plain = revealTravelTimeEffect(state, 'a', 'reduced_travel_time');
    const withOthers = revealTravelTimeEffect({ ...state, stubEdges: { z: ['m'] } }, 'a', 'reduced_travel_time');
    expect(withOthers).toEqual(plain);
    expect('revealedStubId' in plain).toBe(false);
    expect(plain.edges.a).toEqual(['b', 'm']);
    expect(plain.revealedRoomId).toBe('m');
  });

  it('a stub target is never added to edges: edges untouched, hidden entry consumed, revealedRoomId null, revealedStubId set', () => {
    const state = { edges, hiddenEdges: { a: ['m'] }, stubEdges: { a: ['m'] } };
    const r = revealTravelTimeEffect(state, 'a', 'extra_travel_time');
    expect(r.edges).toBe(edges);
    expect(r.hiddenEdges).toEqual({});
    expect(r.revealedRoomId).toBeNull();
    expect(r.revealedStubId).toBe('m');
  });

  it('a non-reveal outcome reveals nothing either way', () => {
    const r = revealTravelTimeEffect({ edges, hiddenEdges: { a: ['m'] }, stubEdges: { a: ['m'] } }, 'a', 'treasure');
    expect(r.revealedRoomId).toBeNull();
    expect(r.revealedStubId ?? null).toBeNull();
    expect(r.hiddenEdges).toEqual({ a: ['m'] });
  });
});

function seedRunState(overrides = {}) {
  return {
    seed: 'test', createdAt: Date.now(), traits: [], excludeTraits: [],
    rooms: {
      'room-entry': { id: 'room-entry', kind: 'safe_entry', isGoal: false, outcomeSlotId: null },
      'start-room': { id: 'start-room', kind: 'combat', isGoal: false, outcomeSlotId: 'pace' },
      'east-room': { id: 'east-room', kind: 'combat', isGoal: false, outcomeSlotId: null },
      'shortcut-target': { id: 'shortcut-target', kind: 'treasure', isGoal: false, outcomeSlotId: null },
    },
    currentRoomId: 'start-room',
    edges: { 'room-entry': ['start-room'], 'start-room': ['east-room'], 'east-room': [], 'shortcut-target': [] },
    layoutEdges: { 'room-entry': ['start-room'], 'start-room': ['east-room'], 'east-room': [], 'shortcut-target': [] },
    hiddenEdges: { 'start-room': ['shortcut-target'] },
    completed: false, history: [], lastAutoEntry: null, previousSceneId: null, objective: null, hostUserId: null,
    aiControlledActorIds: [], ...overrides,
  };
}
function makeSettingsStub(initial = {}) {
  let store = { dungeonRuns: initial };
  return { get: (m, k) => store[k], set: (m, k, v) => { store = { ...store, [k]: v }; } };
}

describe('markRoomOutcome with a hidden stub (#427)', () => {
  it('a revealed false shortcut never joins state.edges, but is reported so its door can be unsealed', async () => {
    const settingsRef = makeSettingsStub();
    const state = seedRunState({ stubEdges: { 'start-room': ['shortcut-target'] } });
    settingsRef.set(MODULE_ID, 'dungeonRuns', { s: state });
    const { state: after, effectKey, revealedRoomId, revealedStubId } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(effectKey).toBe('reduced_travel_time');
    expect(revealedRoomId).toBeNull();
    expect(revealedStubId).toBe('shortcut-target');
    expect(after.edges).toEqual(state.edges);
    expect(after.hiddenEdges['start-room']).toBeUndefined();
    expect(after.stubEdges).toEqual(state.stubEdges);
  });

  it('a state with no stubEdges (v1/v2) round-trips exactly as before', async () => {
    const settingsRef = makeSettingsStub();
    settingsRef.set(MODULE_ID, 'dungeonRuns', { s: seedRunState() });
    const { state: after, revealedRoomId, revealedStubId } = await markRoomOutcome({ sceneId: 's', succeeded: true }, { settingsRef });
    expect(revealedRoomId).toBe('shortcut-target');
    expect(revealedStubId ?? null).toBeNull();
    expect(after.edges['start-room']).toEqual(['east-room', 'shortcut-target']);
    expect('stubEdges' in after).toBe(false);
  });
});

describe('advanceToRoom and roomsToEagerlyBuild with stubs', () => {
  it('advanceToRoom refuses a stub child (it is not in state.edges)', async () => {
    const settingsRef = makeSettingsStub();
    const state = seedRunState({
      edges: { 'room-entry': ['start-room'], 'start-room': ['east-room'], 'east-room': [], 'shortcut-target': [] },
      layoutEdges: { 'room-entry': ['start-room'], 'start-room': ['east-room', 'shortcut-target'], 'east-room': [], 'shortcut-target': [] },
      stubEdges: { 'start-room': ['shortcut-target'] }, hiddenEdges: {},
    });
    settingsRef.set(MODULE_ID, 'dungeonRuns', { s: state });
    const refused = await advanceToRoom({ sceneId: 's', roomId: 'shortcut-target' }, { settingsRef });
    expect(refused.ok).toBe(false);
    expect(getRunState('s', { settingsRef }).currentRoomId).toBe('start-room');
    const ok = await advanceToRoom({ sceneId: 's', roomId: 'east-room' }, { settingsRef });
    expect(ok.ok).toBe(true);
  });

  it('roomsToEagerlyBuild order is identical with and without stubs (layoutEdges is unchanged)', () => {
    for (let i = 0; i < 40; i += 1) {
      const L = buildSweepLayout(i, { layoutVersion: 3 });
      const plan = planStubsForLayout({ ...stubInputsFor(L), retreatAvailable: true });
      const base = { rooms: L.rooms, layoutEdges: L.layoutEdges, edges: L.edges };
      const stubbed = { ...base, edges: applyStubsToEdges(L.edges, plan.stubEdges), stubEdges: plan.stubEdges };
      expect(roomsToEagerlyBuild(stubbed).map((r) => r.room.id)).toEqual(roomsToEagerlyBuild(base).map((r) => r.room.id));
    }
  });
});

describe('stubStateFor (the precompute step of a new run)', () => {
  const L = buildSweepLayout(0, { layoutVersion: 3 });
  const inputs = stubInputsFor(L);

  it('is on for new v3 runs (G3: the scene builds stubs), and never touches v1/v2 runs', () => {
    expect(NEW_RUN_STUBS_ENABLED).toBe(true);
    // the default (no options) is what the app uses: a v3 sweep layout with an eligible hidden shortcut gets stubs
    let withStubs = 0;
    for (let i = 0; i < 100; i += 1) {
      const s = stubStateFor(3, stubInputsFor(buildSweepLayout(i, { layoutVersion: 3 })));
      expect(s.stubEdges).toBeTruthy();
      if (Object.keys(s.stubEdges).length) withStubs += 1;
    }
    expect(withStubs).toBeGreaterThan(0);
    expect('stubEdges' in stubStateFor(2, inputs)).toBe(false);
    for (const v of [1, 2]) {
      const s = stubStateFor(v, inputs, { enabled: true });
      expect(s.edges).toBe(inputs.edges);
      expect('stubEdges' in s).toBe(false);
    }
    const off = stubStateFor(3, inputs, { enabled: false });
    expect(off.edges).toBe(inputs.edges);
    expect('stubEdges' in off).toBe(false);
  });

  it('v3 enabled: stubEdges from the layout planner, stub edges removed from the progression graph, layoutEdges untouched', () => {
    let found = null;
    for (let i = 0; i < 500 && !found; i += 1) {
      const Li = buildSweepLayout(i, { layoutVersion: 3 });
      const inp = stubInputsFor(Li);
      const s = stubStateFor(3, inp, { enabled: true });
      if (Object.keys(s.stubEdges ?? {}).length) found = { Li, inp, s };
    }
    expect(found).toBeTruthy();
    const { inp, s, Li } = found;
    const before = JSON.stringify(Li.edges);
    const plan = planStubsForLayout(inp);
    expect(s.stubEdges).toEqual(plan.stubEdges);
    expect(s.edges).toEqual(applyStubsToEdges(inp.edges, plan.stubEdges));
    expect(JSON.stringify(Li.edges)).toBe(before); // the input graph is not mutated
    // Every stub is a real edge of the layout graph that left the progression graph.
    for (const [src, ts] of Object.entries(s.stubEdges)) for (const t of ts) expect(Li.layoutEdges[src].includes(t) || (Li.hiddenEdges[src] ?? []).includes(t)).toBe(true);
  });
});

describe('stub doors in the scene (unlock and unseal)', () => {
  const doorOf = (flags, ds = 2) => ({ c: [0, 0, 100, 0], door: 1, ds, flags: { [MODULE_ID]: flags } });
  async function sceneWith(...walls) {
    installFoundryStubs();
    globalThis.foundry = { audio: { AudioHelper: { play: () => {} } } };
    const scene = makeFakeScene();
    scene.tokens = [];
    await scene.createEmbeddedDocuments('Wall', walls);
    return scene;
  }

  it('unlockDoorsFromRoom also unlocks the source\'s real stub doors, never a hidden one, never another room\'s', async () => {
    const scene = await sceneWith(
      doorOf({ dungeonStubDoorFor: 'm', dungeonDoorFromRoomId: 'a' }),
      doorOf({ dungeonStubDoorFor: 'h', dungeonDoorFromRoomId: 'a', dungeonHiddenDoorForEdge: 'a->h', dungeonHiddenDoorRole: 'gate' }),
      doorOf({ dungeonStubDoorFor: 'm', dungeonDoorFromRoomId: 'other' }),
      doorOf({ dungeonDoorToRoomId: 'c', dungeonDoorFromRoomId: 'a' }),
    );
    await unlockDoorsFromRoom(scene, 'a', ['c'], ['h']);
    const [stub, hiddenStub, otherStub, real] = scene.walls;
    expect(stub.ds).toBe(0);
    expect(real.ds).toBe(0);
    expect(hiddenStub.ds).toBe(2);
    expect(otherStub.ds).toBe(2);
  });

  it('unsealHiddenDoorFromRoom opens a hidden stub door without promoting it to a progression or reveal door', async () => {
    const scene = await sceneWith(
      doorOf({ dungeonStubDoorFor: 'h', dungeonDoorFromRoomId: 'a', dungeonHiddenDoorForEdge: 'a->h', dungeonHiddenDoorRole: 'gate' }),
    );
    await unsealHiddenDoorFromRoom(scene, 'a', 'h');
    const w = scene.walls[0];
    expect(w.ds).toBe(0);
    expect(w[`flags.${MODULE_ID}.dungeonDoorToRoomId`]).toBeUndefined();
    expect(w[`flags.${MODULE_ID}.dungeonRevealDoorForSlot`]).toBeUndefined();
  });

  it('unsealHiddenDoorFromRoom still promotes a normal hidden door', async () => {
    const scene = await sceneWith(
      doorOf({ dungeonHiddenDoorForEdge: 'a->h', dungeonHiddenDoorRole: 'gate' }),
      doorOf({ dungeonHiddenDoorForEdge: 'a->h', dungeonHiddenDoorRole: 'reveal' }),
    );
    await unsealHiddenDoorFromRoom(scene, 'a', 'h');
    expect(scene.walls[0][`flags.${MODULE_ID}.dungeonDoorToRoomId`]).toBe('h');
    expect(scene.walls[1][`flags.${MODULE_ID}.dungeonRevealDoorForSlot`]).toBe('h');
  });
});
