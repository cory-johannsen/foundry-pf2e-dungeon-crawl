// tests/helpers/scene-oracle.mjs
// Scene-level check for #427: build every room of a sweep layout through the real scene builder on a fake
// Foundry scene, then ask questions of the REAL walls (not the pure geometry's claims).
import { buildPopulateAndUnlockGraphNode } from '../../scripts/dungeon-scene.mjs';
import { buildSweepLayout } from './layout-sweep.mjs';
import { findCorridorPath, outgoingDoorPlan } from '../../scripts/dungeon-layout.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

export function installFoundryStubs() {
  globalThis.CONST = {
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
    WALL_SENSE_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
  };
}

export function makeFakeScene() {
  const walls = [];
  const tiles = [];
  let nextId = 0;
  return {
    id: 'test-scene',
    walls,
    tiles,
    async createEmbeddedDocuments(type, docs) {
      return docs.map((data) => {
        nextId += 1;
        const doc = {
          id: `${type}-${nextId}`,
          ...data,
          getFlag: (moduleId, key) => data.flags?.[moduleId]?.[key],
          update: async (changes) => Object.assign(doc, changes),
        };
        if (type === 'Wall') walls.push(doc);
        if (type === 'Tile') tiles.push(doc);
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

/** Builds every room of `buildSweepLayout(i, { layoutVersion })` and returns `{ layout, scene }`. */
export async function buildSweepScene(i, layoutVersion, layoutOptions = {}) {
  return buildSceneForLayout(buildSweepLayout(i, { layoutVersion, ...layoutOptions }), layoutVersion);
}

/** Same, for an already-built layout (e.g. a reseeded candidate). */
export async function buildSceneForLayout(L, layoutVersion) {
  installFoundryStubs();
  const scene = makeFakeScene();
  const state = {
    seed: L.seed, layoutPositionByRoomId: L.pos, incomingFaceByRoomId: L.incFace, hiddenRooms: L.hiddenRooms,
    edges: L.edges, layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId,
    hiddenEdges: L.hiddenEdges, layoutVersion, maxRank: 20,
    // #427: a stub-aware sweep layout (tests/helpers/stub-sweep.mjs) carries the planned stubs; absent = none.
    ...(L.stubEdges ? { stubEdges: L.stubEdges } : {}),
    // #585: dead edges walled instead of built.
    ...(L.walledEdges ? { walledEdges: L.walledEdges } : {}),
    // #427: a topology-routed run (stamped at creation) routes its corridors in the scene.
    ...(L.topologyRouting ? { topologyRouting: true } : {}),
  };
  for (const id of Object.keys(L.rooms)) {
    await buildPopulateAndUnlockGraphNode(scene, state, {
      id, kind: 'narrative', isGoal: false, locationTag: null, artVariant: 0, setpieceId: null,
    }, {
      rank: L.pos[id].rank, col: L.pos[id].col, childIds: L.edges[id] ?? [],
      hiddenChildId: (L.hiddenEdges[id] ?? [])[0] ?? null, unlock: false,
    });
  }
  return { layout: L, scene };
}

const overlapsOnLine = (w, d) => {
  const [x1, y1, x2, y2] = d.c;
  const [a, b, c, e] = w.c;
  if (y1 === y2) return b === y1 && e === y1 && Math.max(Math.min(a, c), Math.min(x1, x2)) < Math.min(Math.max(a, c), Math.max(x1, x2));
  return a === x1 && c === x1 && Math.max(Math.min(b, e), Math.min(y1, y2)) < Math.min(Math.max(b, e), Math.max(y1, y2));
};

/** Door walls whose span is covered, even partly, by a collinear SOLID wall (the door cannot be walked
 * through in full): `{ doors, sealed, byFlag }`. */
export function sealedDoors(scene) {
  const solid = scene.walls.filter((w) => !w.door);
  const doors = scene.walls.filter((w) => w.door);
  const sealed = doors.filter((d) => solid.some((w) => overlapsOnLine(w, d)));
  return {
    doors: doors.length,
    sealed: sealed.length,
    sealedDoorWalls: sealed.map((d) => ({ coords: d.c, flags: d.flags?.[MODULE_ID] ?? {} })),
  };
}

function edgeOfDoor(d) {
  const f = d.flags?.[MODULE_ID] ?? {};
  if (f.dungeonHiddenDoorForEdge) {
    const [from, to] = f.dungeonHiddenDoorForEdge.split('->');
    return { from, to, hidden: true };
  }
  return { from: f.dungeonDoorFromRoomId, to: f.dungeonDoorToRoomId ?? f.dungeonRevealDoorForSlot, hidden: false };
}

/**
 * #490: edge-level view of a built sweep scene. An edge (`from->to`) is sealed when ANY of its door walls is
 * (the oracle above). Each sealed edge gets the routing cause behind its geometry, from the same
 * `findCorridorPath` the builder used: `noPathGateHeld` (no free route because the target's one incoming gate
 * cell is held by a co-parent, so `buildEdgeCorridor` falls back to its straight line through that room),
 * `noPathOther`, `multiCell`, `adjacent`. `unreachable` lists the non-hidden rooms a flood over the REAL edges
 * (never hidden ones) from room-entry misses when sealed edges are impassable.
 */
export function sealedEdgeReport(layout, scene) {
  const solid = scene.walls.filter((w) => !w.door);
  const doors = scene.walls.filter((w) => w.door);
  const sealedDoorSet = new Set(doors.filter((d) => solid.some((w) => overlapsOnLine(w, d))));
  const edges = new Map();
  for (const d of doors) {
    const { from, to, hidden } = edgeOfDoor(d);
    if (!to) continue;
    const key = `${from}->${to}`;
    const e = edges.get(key) ?? { from, to, hidden, sealed: false };
    if (sealedDoorSet.has(d)) e.sealed = true;
    edges.set(key, e);
  }
  const planFor = (src) => outgoingDoorPlan(
    layout.rect[src], layout.pos[src],
    { realChildIds: layout.edges[src] ?? [], hiddenChildIds: (layout.hiddenEdges[src] ?? []).slice(0, 1) }, layout.pos,
  );
  const causeOf = ({ from, to }) => {
    const plan = planFor(from).get(to);
    const path = findCorridorPath(layout.pos[from], layout.pos[to], layout.occ, {
      fromRoomId: from, toRoomId: to, incomingFace: layout.incFace[to], exitFace: plan?.face,
    });
    if (path) return path.length > 2 ? 'multiCell' : 'adjacent';
    const p = layout.pos[to];
    const gate = layout.incFace[to] === 'west' ? { rank: p.rank, col: p.col - 1 } : { rank: p.rank - 1, col: p.col };
    const holder = layout.occ[`${gate.rank},${gate.col}`];
    return holder && holder !== from ? 'noPathGateHeld' : 'noPathOther';
  };
  const all = [...edges.values()];
  const sealedEdges = all.filter((e) => e.sealed).map((e) => {
    const incoming = all.filter((o) => o.to === e.to);
    return { ...e, cause: causeOf(e), sole: incoming.length === 1, altOk: incoming.some((o) => !o.sealed) };
  });
  const seen = new Set(['room-entry']);
  for (let grew = true; grew;) {
    grew = false;
    for (const [s, kids] of Object.entries(layout.edges)) {
      for (const c of kids) {
        if (seen.has(s) && !seen.has(c) && !edges.get(`${s}->${c}`)?.sealed) { seen.add(c); grew = true; }
      }
    }
  }
  const unreachable = Object.keys(layout.rooms).filter((r) => !seen.has(r) && !layout.hiddenRooms.includes(r));
  return { sealedDoors: sealedDoorSet.size, sealedEdges, unreachable, goalReachable: seen.has('room-goal') };
}

const doorMid = (d) => ({ x: (d.c[0] + d.c[2]) / 2, y: (d.c[1] + d.c[3]) / 2, horizontal: d.c[1] === d.c[3] });

// Does the axis-aligned wall `w` properly cross the axis-aligned segment p-q? Touching an end of the segment
// (the door the line starts or ends on) does not count; the center lines run 50px off every 100px grid line, so
// a wall is never collinear with them.
function wallCrossesSegment(p, q, w) {
  const [a, b, c, e] = w.c;
  const [wx0, wx1, wy0, wy1] = [Math.min(a, c), Math.max(a, c), Math.min(b, e), Math.max(b, e)];
  if (p.x === q.x) return wy0 === wy1 && wy0 > Math.min(p.y, q.y) && wy0 < Math.max(p.y, q.y) && p.x >= wx0 && p.x <= wx1;
  return wx0 === wx1 && wx0 > Math.min(p.x, q.x) && wx0 < Math.max(p.x, q.x) && p.y >= wy0 && p.y <= wy1;
}

/**
 * #490: is the corridor of a real edge walkable from its outgoing door to its reveal door? Walks the corridor's
 * center line (out of the door, along the first leg, then the second leg into the reveal door: the corner shape
 * `buildEdgeCorridor` draws for a null path) and returns the SOLID walls it crosses, each as
 * `{ coords, kind, roomId }`. An empty list means the line is walkable once the doors themselves are unsealed.
 */
export function corridorLineBlockers(scene, { from, to }) {
  const out = scene.walls.find((w) => w.door && w.flags?.[MODULE_ID]?.dungeonDoorToRoomId === to && w.flags[MODULE_ID].dungeonDoorFromRoomId === from);
  const rev = scene.walls.find((w) => w.door && w.flags?.[MODULE_ID]?.dungeonRevealDoorForSlot === to && w.flags[MODULE_ID].dungeonDoorFromRoomId === from);
  if (!out || !rev) return null;
  const c1 = doorMid(out);
  const c2 = doorMid(rev);
  const pts = c1.horizontal
    ? [c1, { x: c1.x, y: c1.y + 50 }, { x: c2.x, y: c1.y + 50 }, c2]
    : [c1, { x: c2.x, y: c1.y }, c2];
  const found = new Set();
  const blockers = [];
  for (let s = 0; s < pts.length - 1; s += 1) {
    for (const w of scene.walls) {
      if (w.door || found.has(w) || !wallCrossesSegment(pts[s], pts[s + 1], w)) continue;
      found.add(w);
      const f = w.flags?.[MODULE_ID] ?? {};
      const key = Object.keys(f).find((k) => /Wall/.test(k));
      blockers.push({ coords: w.c, kind: key ? key.replace(/^dungeon|ForRoom$/g, '') : 'corridorPlain', roomId: f[key] ?? null });
    }
  }
  return blockers;
}

/**
 * #490 (reject-and-reseed): the PURE-layout validity verdict (no scene build, ~0.25 ms): a real edge is dead when
 * `findCorridorPath` is null for it. It cannot see sealed doors on non-null corridors, so it never rejects a
 * scene-valid layout (recall 1.0 measured) but accepts some scene-invalid ones (precision ~0.93).
 */
export function layoutValidity(layout) {
  const dead = new Set();
  for (const [from, kids] of Object.entries(layout.edges)) {
    const plan = outgoingDoorPlan(layout.rect[from], layout.pos[from], {
      realChildIds: kids, hiddenChildIds: (layout.hiddenEdges[from] ?? []).slice(0, 1),
    }, layout.pos);
    for (const to of kids) {
      const path = findCorridorPath(layout.pos[from], layout.pos[to], layout.occ, {
        fromRoomId: from, toRoomId: to, incomingFace: layout.incFace[to], exitFace: plan.get(to)?.face,
      });
      if (!path) dead.add(`${from}->${to}`);
    }
  }
  const seen = new Set(['room-entry']);
  for (let grew = true; grew;) {
    grew = false;
    for (const [s, kids] of Object.entries(layout.edges)) {
      for (const c of kids) if (seen.has(s) && !seen.has(c) && !dead.has(`${s}->${c}`)) { seen.add(c); grew = true; }
    }
  }
  const unreachable = Object.keys(layout.rooms).filter((r) => !seen.has(r) && !layout.hiddenRooms.includes(r));
  return { goalReachable: seen.has('room-goal'), unreachable, deadEdges: dead.size };
}

/**
 * #490 (reject-and-reseed): the SCENE-level validity verdict a candidate seed is measured against. A real edge is
 * dead when any of its door walls is sealed (`sealedEdgeReport`) OR its corridor is the null-path fallback (a
 * straight line through foreign cells: 0 of 1106 measured ones were walkable, see corridorLineBlockers). Flood
 * over the live real edges from room-entry: `goalReachable`, `unreachable` (non-hidden rooms missed) and
 * `soleDead` (a dead real edge that is its target's only incoming real edge).
 */
export function sceneValidity(layout, scene) {
  const report = sealedEdgeReport(layout, scene);
  const sealed = new Set(report.sealedEdges.filter((e) => !e.hidden).map((e) => `${e.from}->${e.to}`));
  const dead = new Set();
  const incoming = {};
  for (const [from, kids] of Object.entries(layout.edges)) {
    const plan = outgoingDoorPlan(layout.rect[from], layout.pos[from], {
      realChildIds: kids, hiddenChildIds: (layout.hiddenEdges[from] ?? []).slice(0, 1),
    }, layout.pos);
    for (const to of kids) {
      incoming[to] = (incoming[to] ?? 0) + 1;
      const path = findCorridorPath(layout.pos[from], layout.pos[to], layout.occ, {
        fromRoomId: from, toRoomId: to, incomingFace: layout.incFace[to], exitFace: plan.get(to)?.face,
      });
      if (!path || sealed.has(`${from}->${to}`)) dead.add(`${from}->${to}`);
    }
  }
  const seen = new Set(['room-entry']);
  for (let grew = true; grew;) {
    grew = false;
    for (const [s, kids] of Object.entries(layout.edges)) {
      for (const c of kids) if (seen.has(s) && !seen.has(c) && !dead.has(`${s}->${c}`)) { seen.add(c); grew = true; }
    }
  }
  const unreachable = Object.keys(layout.rooms).filter((r) => !seen.has(r) && !layout.hiddenRooms.includes(r));
  const soleDead = [...dead].filter((k) => incoming[k.split('->')[1]] === 1).length;
  return { goalReachable: seen.has('room-goal'), unreachable, deadEdges: dead.size, soleDead };
}
