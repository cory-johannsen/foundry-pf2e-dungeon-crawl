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
  installFoundryStubs();
  const L = buildSweepLayout(i, { layoutVersion, ...layoutOptions });
  const scene = makeFakeScene();
  const state = {
    seed: L.seed, layoutPositionByRoomId: L.pos, incomingFaceByRoomId: L.incFace, hiddenRooms: L.hiddenRooms,
    edges: L.edges, layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId,
    hiddenEdges: L.hiddenEdges, layoutVersion, maxRank: 20,
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
