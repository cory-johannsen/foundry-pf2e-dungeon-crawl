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
 * out so a candidate and the real run share one code path. `evaluateLayout` builds the layout's scene on a scratch
 * (in-memory) scene with the real scene builder and floods the truth-live graph. Its verdict is the same as the test
 * oracle's `truth` (tests/helpers/stub-oracle-aware.mjs `oracleReports`); tests/dungeon-reseed.test.mjs proves that
 * over 500 seeds.
 */
import {
  computeRanks, computeColumns, parentRoomIdsFor, incomingFaceFor, pruneConflictingShortcuts, stubStateFor,
  NEW_RUN_LAYOUT_VERSION, roomRect, outgoingDoorPlan, findCorridorPath,
} from './dungeon-layout.mjs';
import { buildPopulateAndUnlockGraphNode } from './dungeon-scene.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

/** How many reseeds are tried after the original seed (user decision: N = 10, 99.8% goal-reachable measured). */
export const RESEED_MAX_TRIES = 10;

/** Candidate k of `seed`: k = 0 is the seed itself. */
export const candidateSeed = (seed, k) => (k === 0 ? seed : `${seed}~r${k}`);

/** Run-state fields for debugging; layoutVersion < 3 gets none (v1/v2 states stay byte-identical). */
export function reseedStateFor(layoutVersion, { seedOrigin, reseedTries }) {
  return layoutVersion >= 3 ? { seedOrigin, reseedTries } : {};
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
 * and (layoutVersion >= 3) the stub plan. Pure; `generator` is `getGenerator()` (or the dungeon-deck module).
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
  // #427: stubs leave the progression graph (`edges`) but stay in `layoutEdges`, so no room moves.
  const { edges, stubEdges } = stubStateFor(layoutVersion, {
    seed, rooms, positionByRoomId: layoutPositionByRoomId, occupiedCells,
    edges: edgesBeforeStubs, layoutEdges, hiddenEdges, hiddenRooms: [...hiddenRooms], hiddenIncomingByRoomId,
    incomingFaceByRoomId,
  });
  return {
    seed, layoutVersion, rooms, edges, ...(stubEdges ? { stubEdges } : {}), layoutEdges, hiddenRooms: [...hiddenRooms],
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

const edgeKey = (from, to) => `${from}->${to}`;

// A door wall's span is covered, even partly, by a collinear SOLID wall.
function overlapsOnLine(w, d) {
  const [x1, y1, x2, y2] = d.c;
  const [a, b, c, e] = w.c;
  if (y1 === y2) return b === y1 && e === y1 && Math.max(Math.min(a, c), Math.min(x1, x2)) < Math.min(Math.max(a, c), Math.max(x1, x2));
  return a === x1 && c === x1 && Math.max(Math.min(b, e), Math.min(y1, y2)) < Math.min(Math.max(b, e), Math.max(y1, y2));
}

const doorMid = (d) => ({ x: (d.c[0] + d.c[2]) / 2, y: (d.c[1] + d.c[3]) / 2, horizontal: d.c[1] === d.c[3] });

// Does the axis-aligned wall `w` properly cross the axis-aligned segment p-q? Touching an end does not count.
function wallCrossesSegment(p, q, w) {
  const [a, b, c, e] = w.c;
  const [wx0, wx1, wy0, wy1] = [Math.min(a, c), Math.max(a, c), Math.min(b, e), Math.max(b, e)];
  if (p.x === q.x) return wy0 === wy1 && wy0 > Math.min(p.y, q.y) && wy0 < Math.max(p.y, q.y) && p.x >= wx0 && p.x <= wx1;
  return wx0 === wx1 && wx0 > Math.min(p.x, q.x) && wx0 < Math.max(p.x, q.x) && p.y >= wy0 && p.y <= wy1;
}

/** Is the null-path fallback corridor of real edge `from->to` walkable along its centre line (no solid wall crossed)? */
function centreLineClear(scene, from, to) {
  const flag = (w) => w.flags?.[MODULE_ID] ?? {};
  const out = scene.walls.find((w) => w.door && flag(w).dungeonDoorToRoomId === to && flag(w).dungeonDoorFromRoomId === from);
  const rev = scene.walls.find((w) => w.door && flag(w).dungeonRevealDoorForSlot === to && flag(w).dungeonDoorFromRoomId === from);
  if (!out || !rev) return false;
  const c1 = doorMid(out);
  const c2 = doorMid(rev);
  const pts = c1.horizontal
    ? [c1, { x: c1.x, y: c1.y + 50 }, { x: c2.x, y: c1.y + 50 }, c2]
    : [c1, { x: c2.x, y: c1.y }, c2];
  for (let s = 0; s < pts.length - 1; s += 1) {
    for (const w of scene.walls) if (!w.door && wallCrossesSegment(pts[s], pts[s + 1], w)) return false;
  }
  return true;
}

/**
 * The `truth` verdict of a built scene: flood from room-entry over `layout.edges` skipping dead real edges. An edge is
 * dead when one of its doors is sealed by a solid wall, or it is a null-path fallback (no free corridor) whose centre
 * line crosses a wall. Returns `{ goal, unreachable }` (`unreachable` = number of non-hidden rooms the flood misses).
 */
function truthVerdict(layout, scene) {
  const solid = scene.walls.filter((w) => !w.door);
  const sealedEdges = new Set();
  for (const d of scene.walls.filter((w) => w.door)) {
    const f = d.flags?.[MODULE_ID] ?? {};
    if (f.dungeonHiddenDoorForEdge) continue; // detour/shortcut doors are not progression edges
    const to = f.dungeonDoorToRoomId ?? f.dungeonRevealDoorForSlot;
    if (to && solid.some((w) => overlapsOnLine(w, d))) sealedEdges.add(edgeKey(f.dungeonDoorFromRoomId, to));
  }
  const rect = Object.fromEntries(Object.keys(layout.rooms).map((id) => {
    const p = layout.layoutPositionByRoomId[id];
    return [id, roomRect(layout.seed, id, p.rank, p.col)];
  }));
  const dead = new Set();
  for (const [from, kids] of Object.entries(layout.edges)) {
    const plan = outgoingDoorPlan(rect[from], layout.layoutPositionByRoomId[from], {
      realChildIds: kids, hiddenChildIds: (layout.hiddenEdges[from] ?? []).slice(0, 1),
    }, layout.layoutPositionByRoomId);
    for (const to of kids) {
      const k = edgeKey(from, to);
      const path = findCorridorPath(layout.layoutPositionByRoomId[from], layout.layoutPositionByRoomId[to], layout.occupiedCells, {
        fromRoomId: from, toRoomId: to, incomingFace: layout.incomingFaceByRoomId[to], exitFace: plan.get(to)?.face,
      });
      if (sealedEdges.has(k) || (!path && !centreLineClear(scene, from, to))) dead.add(k);
    }
  }
  const seen = new Set(['room-entry']);
  const queue = ['room-entry'];
  while (queue.length) {
    const x = queue.shift();
    for (const c of layout.edges[x] ?? []) if (!seen.has(c) && !dead.has(edgeKey(x, c))) { seen.add(c); queue.push(c); }
  }
  const unreachable = Object.keys(layout.rooms).filter((r) => !seen.has(r) && !layout.hiddenRooms.includes(r)).length;
  return { goal: seen.has('room-goal'), unreachable };
}

/** Verdict `{ goal, unreachable }` for a `computeRunLayout` result: build its walls, flood the truth-live graph. */
export async function evaluateLayout(layout) {
  return truthVerdict(layout, await buildScratchScene(layout));
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
    const layout = build(s);
    layouts.set(s, layout);
    return evaluateLayout(layout);
  };
  const r = await selectSeed({ seed, evaluate, maxTries, yieldFn });
  if (r.exhausted) warn(`no goal-reachable layout for seed "${seed}" in ${maxTries + 1} candidates; keeping "${r.seed}"`);
  return { layout: layouts.get(r.seed), ...r, ms: Date.now() - t0 };
}
