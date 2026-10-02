/**
 * #490: goal-only reject-and-reseed for new runs (layoutVersion >= 3).
 *
 * Some generated dungeons cannot be finished: a sealed door, or a corridor that had to fall back to a straight line
 * through a foreign room, makes the goal unreachable from room-entry. This module builds a run's layout for the run
 * seed, checks that the goal is reachable over the edges the scene can really walk (AFTER the stub plan), and when it
 * is not tries the seeds `<seed>~r1` .. `<seed>~rN` (deterministic: the same original seed always ends on the same
 * final seed). If none works it keeps the best candidate and warns; it never blocks run creation and is bounded by N.
 *
 * `selectSeed` is pure given an `evaluate(seed)`. `computeRunLayout` is the precompute `startDungeonRun` runs, factored
 * out so a candidate and the real run share one code path (it returns the layout STUB-FREE). `planRunLayoutStubs`
 * (#427 Chunk 7) adds the stubs: it builds the layout's scene on a scratch (in-memory) scene with the real scene
 * builder and plans them against the dead edges (scripts/dungeon-stub-oracle.mjs). The verdict is the goal flooding
 * the `union` live graph, which is the test oracle's `truth` (tests/helpers/stub-oracle-aware.mjs `oracleReports`)
 * PLUS (#575) the per-edge door-to-door walkability (tests/helpers/walkability-oracle.mjs `edgeWalkability`);
 * tests/dungeon-reseed.test.mjs proves that over 500 seeds.
 */
import {
  computeRanks, computeColumns, parentRoomIdsFor, incomingFaceFor, pruneConflictingShortcuts, NEW_RUN_LAYOUT_VERSION,
} from './dungeon-layout.mjs';
import { buildPopulateAndUnlockGraphNode } from './dungeon-scene.mjs';
import { deadEdgeSets, verdictsOf, planStubsVerified } from './dungeon-stub-oracle.mjs';
import { RETREAT_VERSION } from './dungeon-retreat.mjs';

/** How many reseeds are tried after the original seed (user decision: N = 20, ~100% goal-reachable measured). */
export const RESEED_MAX_TRIES = 20;

/** Candidate k of `seed`: k = 0 is the seed itself. */
export const candidateSeed = (seed, k) => (k === 0 ? seed : `${seed}~r${k}`);

/** Run-state fields for debugging; layoutVersion < 3 gets none (v1/v2 states stay byte-identical). */
export function reseedStateFor(layoutVersion, { seedOrigin, reseedTries }) {
  return layoutVersion >= 3 ? { seedOrigin, reseedTries } : {};
}

/**
 * #585: run-state fields of the dead-edge walls: `walledEdges` (`{ source: [target] }`, absent when none) and the
 * `deadEdgeWalls: true` flag that gates the generalised Turn back (scripts/dungeon-retreat.mjs). layoutVersion < 3 gets
 * none (v1/v2 byte-identical); a v3 run created before this change has neither and keeps its old behaviour.
 */
export function deadEdgeWallsStateFor(layoutVersion, walledEdges) {
  if (!(layoutVersion >= 3)) return {};
  return { deadEdgeWalls: true, ...(walledEdges ? { walledEdges } : {}) };
}

const better = (a, b) => (a.goal !== b.goal ? a.goal : a.unreachable < b.unreachable);

/**
 * Try the candidate seeds in order and return the first whose verdict has `goal` true. `evaluate(seed)` resolves to
 * `{ goal: boolean, unreachable: number }`. When no candidate reaches the goal the best one is kept (goal, then fewest
 * unreachable rooms, earliest on ties) and `exhausted` is true. At most `1 + maxTries` evaluations. `yieldFn` runs
 * between candidates so a caller can hand the thread back to the UI.
 * Returns `{ seed, seedOrigin, reseedTries, goalReachable, exhausted, verdict }`.
 */
export async function selectSeed({ seed, evaluate, maxTries = RESEED_MAX_TRIES, yieldFn = null }) {
  let best = null;
  for (let k = 0; k <= maxTries; k += 1) {
    if (k > 0 && yieldFn) await yieldFn();
    const s = candidateSeed(seed, k);
    const verdict = await evaluate(s);
    if (!best || better(verdict, best.verdict)) best = { k, seed: s, verdict };
    if (verdict.goal) break;
  }
  return {
    seed: best.seed, seedOrigin: seed, reseedTries: best.k, goalReachable: best.verdict.goal,
    exhausted: !best.verdict.goal, verdict: best.verdict,
  };
}

/**
 * The layout precompute of `startDungeonRun` for `seed`: room graph, rest room, hidden paths, positions, incoming faces
 * Stub-free (`planRunLayoutStubs` adds the stub plan). Pure; `generator` is `getGenerator()` (or the dungeon-deck module).
 * `setpieceIds` is `{ puzzle, trap, narrative, treasure }`, each an id list.
 */
export function computeRunLayout({ generator, seed, roomCount, setpieceIds = {}, layoutVersion = NEW_RUN_LAYOUT_VERSION }) {
  const { puzzle: puzzleSetpieceIds, trap: trapSetpieceIds, narrative: narrativeSetpieceIds, treasure: treasureSetpieceIds } = setpieceIds;
  const sets = { puzzleSetpieceIds, trapSetpieceIds, narrativeSetpieceIds, treasureSetpieceIds };
  const generated = generator.buildRoomGraph({ seed, roomCount, ...sets });
  // The rest room goes in BEFORE attachHiddenPaths (#93): a hidden path must never pick it as its source.
  const { rooms, edges: edgesBeforeStubs } = generator.insertRestRoom({
    rooms: generated.rooms, edges: generated.edges, seed, roomCount,
  });
  const { hiddenRooms, hiddenEdges: attachedHiddenEdges, layoutEdges, hiddenIncomingByRoomId: attachedHiddenIncoming } =
    generator.attachHiddenPaths({ rooms, edges: edgesBeforeStubs, seed, ...sets });
  // #156: ranks/columns come from layoutEdges (they include detour rooms).
  const ranks = computeRanks(layoutEdges, 'room-entry');
  const columns = computeColumns(layoutEdges, ranks, 'room-entry');
  const layoutPositionByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => [id, { rank: ranks[id], col: columns[id] }]),
  );
  // #415 Chunk 5: drop optional hidden shortcuts that share an outgoing face lane; must precede the incoming faces.
  const { hiddenEdges, hiddenIncomingByRoomId } = pruneConflictingShortcuts({
    edges: edgesBeforeStubs, hiddenRooms, hiddenEdges: attachedHiddenEdges, hiddenIncomingByRoomId: attachedHiddenIncoming,
  }, layoutPositionByRoomId);
  const occupiedCells = {};
  for (const [id, pos] of Object.entries(layoutPositionByRoomId)) occupiedCells[`${pos.rank},${pos.col}`] = id;
  const incomingFaceByRoomId = Object.fromEntries(
    Object.keys(rooms).map((id) => {
      const legitimateSourceIds = new Set([...parentRoomIdsFor(layoutEdges, id), ...(hiddenIncomingByRoomId[id] ?? [])]);
      return [id, incomingFaceFor(id, layoutPositionByRoomId, occupiedCells, legitimateSourceIds)];
    }),
  );
  // #427 Chunk 7: the layout is returned STUB-FREE; `planRunLayoutStubs` (async, it builds the scene) adds the stubs
  // (they leave the progression graph `edges` but stay in `layoutEdges`, so no room moves).
  return {
    seed, layoutVersion, rooms, edges: edgesBeforeStubs, layoutEdges, hiddenRooms: [...hiddenRooms],
    hiddenEdges, hiddenIncomingByRoomId, layoutPositionByRoomId, incomingFaceByRoomId, occupiedCells,
    maxRank: Math.max(...Object.values(ranks)), maxCol: Math.max(...Object.values(columns)),
  };
}

/** An in-memory scene with just what the wall/tile part of the scene builder touches. */
function makeScratchScene() {
  const walls = [];
  const tiles = [];
  let nextId = 0;
  return {
    id: 'reseed-scratch', walls, tiles,
    async createEmbeddedDocuments(type, docs) {
      return docs.map((data) => {
        nextId += 1;
        const doc = {
          id: `${type}-${nextId}`, ...data,
          getFlag: (moduleId, key) => data.flags?.[moduleId]?.[key],
          update: async (changes) => Object.assign(doc, changes),
        };
        (type === 'Wall' ? walls : tiles).push(doc);
        return doc;
      });
    },
    async deleteEmbeddedDocuments(type, ids) {
      const arr = type === 'Wall' ? walls : tiles;
      for (const id of ids) {
        const idx = arr.findIndex((d) => d.id === id);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
  };
}

/** Build every room's walls of `layout` on a scratch scene with the real scene builder (no content, no Foundry doc). */
async function buildScratchScene(layout) {
  const scene = makeScratchScene();
  const state = {
    seed: layout.seed, layoutPositionByRoomId: layout.layoutPositionByRoomId, incomingFaceByRoomId: layout.incomingFaceByRoomId,
    hiddenRooms: layout.hiddenRooms, edges: layout.edges, layoutEdges: layout.layoutEdges,
    hiddenIncomingByRoomId: layout.hiddenIncomingByRoomId, hiddenEdges: layout.hiddenEdges, layoutVersion: layout.layoutVersion,
    maxRank: layout.maxRank, ...(layout.stubEdges ? { stubEdges: layout.stubEdges } : {}),
    ...(layout.walledEdges ? { walledEdges: layout.walledEdges } : {}),
  };
  for (const id of Object.keys(layout.rooms)) {
    const pos = layout.layoutPositionByRoomId[id];
    await buildPopulateAndUnlockGraphNode(scene, state, {
      id, kind: 'narrative', isGoal: false, locationTag: null, artVariant: 0, setpieceId: null,
    }, {
      rank: pos.rank, col: pos.col, childIds: layout.edges[id] ?? [],
      hiddenChildId: (layout.hiddenEdges[id] ?? [])[0] ?? null, unlock: false,
    });
  }
  return scene;
}

/**
 * Verdict `{ goal, unreachable }` of a layout (stub-free or stubbed): build its walls, flood the `union` live graph
 * (scripts/dungeon-stub-oracle.mjs `deadEdgeSets`: sealed doors, null-path fallback lines through walls, and #575
 * edges not walkable door to door). `unreachable` is the number of non-hidden rooms the flood misses.
 */
export async function evaluateLayout(layout) {
  const v = verdictsOf(layout, deadEdgeSets(layout, await buildScratchScene(layout))).union;
  return { goal: v.goal, unreachable: v.unreachable.length };
}

/**
 * #427 Chunk 7: the stub plan of a stub-free `computeRunLayout` result (layoutVersion >= 3), judged on the scene
 * (`planStubsVerified`): every dead edge (union oracle) that the eligibility rules allow becomes a rubble-capped stub,
 * sole-child sources included because retreat (#439) is live (`retreatAvailable`). Returns
 * `{ layout (stubs applied, dead edges walled: `walledEdges`), verdict: { goal, unreachable }, dropped, walled, lost }`;
 * the verdict is the final scene's, after the walls (#585).
 */
export async function planRunLayoutStubs(layout, { retreatAvailable = RETREAT_VERSION >= 1 } = {}) {
  const r = await planStubsVerified({ layout, buildScene: buildScratchScene, retreatAvailable });
  const v = r.verdicts.union;
  // #585: the verdict is of the final scene AFTER the dead-edge walls. A layout where door re-slotting killed an edge the
  // stub-free scene could walk (and so lost a room or the goal) is not acceptable either: it counts as not goal-reachable,
  // so the reseed moves on to the next candidate.
  return {
    layout: r.layout, verdict: { goal: v.goal && !r.lost, unreachable: v.unreachable.length }, dropped: r.dropped,
    walled: r.walled, lost: r.lost,
  };
}

/**
 * The whole step for `startDungeonRun`: for layoutVersion >= 3 pick the final seed (see `selectSeed`) and return
 * `{ layout, seed, seedOrigin, reseedTries, goalReachable, exhausted, ms }`; below 3 the original seed's layout is
 * returned untouched (no reseed, no evaluation). `warn(msg)` is called when no candidate reaches the goal.
 */
export async function chooseRunLayout({
  generator, seed, roomCount, setpieceIds = {}, layoutVersion = NEW_RUN_LAYOUT_VERSION,
  maxTries = RESEED_MAX_TRIES, yieldFn = null, warn = () => {},
}) {
  const t0 = Date.now();
  const build = (s) => computeRunLayout({ generator, seed: s, roomCount, setpieceIds, layoutVersion });
  if (!(layoutVersion >= 3)) {
    return { layout: build(seed), seed, seedOrigin: seed, reseedTries: 0, goalReachable: null, exhausted: false, ms: 0 };
  }
  const layouts = new Map();
  const evaluate = async (s) => {
    // Stubs are part of the candidate: the verdict is the goal's reachability AFTER the stub plan.
    const planned = await planRunLayoutStubs(build(s), { retreatAvailable: layoutVersion >= 3 && RETREAT_VERSION >= 1 });
    layouts.set(s, planned.layout);
    return planned.verdict;
  };
  const r = await selectSeed({ seed, evaluate, maxTries, yieldFn });
  if (r.exhausted) warn(`no goal-reachable layout for seed "${seed}" in ${maxTries + 1} candidates; keeping "${r.seed}"`);
  return { layout: layouts.get(r.seed), ...r, ms: Date.now() - t0 };
}
