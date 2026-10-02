// tests/helpers/walkability-oracle.mjs
// #575: per-edge door-to-door WALKABILITY of a built (fake) scene. For every real edge `from->to` it asks whether a
// token can walk from the cell just outside the edge's outgoing door to the cell just outside its reveal door over
// the corridor TILE floor, with the scene's solid walls (and every other door) as blockers. Unlike the sealed-door
// oracle (a door covered by a collinear wall) and the `truth` oracle (null-path fallback line crossing a wall), this
// also catches a FOUND-path edge whose corridor is cut by another edge's flank / margin walls, and tile gaps.
import { buildSceneForLayout } from './scene-oracle.mjs';
import { findCorridorPath, outgoingDoorPlan, roomRect } from '../../scripts/dungeon-layout.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const CELL = 100;
const ck = (cx, cy) => `${cx},${cy}`;

function unitEdges(walls) {
  // vertical unit edge at x between cells (x-1,y) and (x,y): key `x,y`; horizontal at y between (x,y-1),(x,y): `x,y`
  const v = new Map();
  const h = new Map();
  let fractional = 0;
  for (const w of walls) {
    // A wall covering even part of a unit edge blocks the whole edge (the sealed-door oracle's "partly covered"
    // rule): floor the low end, ceil the high end. Half-cell plain walls exist (reveal-door flanks).
    const [a, b, c, e] = w.c.map((n) => n / CELL);
    if (![a, b, c, e].every(Number.isInteger)) fractional += 1;
    const lo = (n1, n2) => Math.floor(Math.min(n1, n2) + 1e-9);
    const hi = (n1, n2) => Math.ceil(Math.max(n1, n2) - 1e-9);
    const push = (map, key) => (map.get(key) ?? map.set(key, []).get(key)).push(w);
    if (a === c) {
      for (let y = lo(b, e); y < hi(b, e); y += 1) push(v, ck(Math.round(a), y));
    } else {
      for (let x = lo(a, c); x < hi(a, c); x += 1) push(h, ck(x, Math.round(b)));
    }
  }
  return { v, h, fractional };
}

/** Build the walk model of `scene`: tile floor cells, blocking wall unit-edges, connected components. */
export function buildWalkModel(scene) {
  const floor = new Set();
  for (const t of scene.tiles) {
    const w = Math.max(1, Math.round((t.width ?? CELL) / CELL));
    const h = Math.max(1, Math.round((t.height ?? CELL) / CELL));
    const x0 = Math.round((t.x - (t.width ?? CELL) / 2) / CELL);
    const y0 = Math.round((t.y - (t.height ?? CELL) / 2) / CELL);
    for (let i = 0; i < w; i += 1) for (let j = 0; j < h; j += 1) floor.add(ck(x0 + i, y0 + j));
  }
  const solid = unitEdges(scene.walls.filter((w) => !w.door));
  const doors = unitEdges(scene.walls.filter((w) => w.door));
  const blockedBy = (maps, ax, ay, bx, by) => (ax !== bx
    ? maps.v.get(ck(Math.max(ax, bx), ay))
    : maps.h.get(ck(ax, Math.max(ay, by))));
  const comp = new Map();
  const flood = (start, ignoreWalls) => {
    const seen = new Set([start]);
    const q = [start];
    while (q.length) {
      const [x, y] = q.pop().split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = ck(x + dx, y + dy);
        if (seen.has(k) || !floor.has(k)) continue;
        if (!ignoreWalls && (blockedBy(solid, x, y, x + dx, y + dy) || blockedBy(doors, x, y, x + dx, y + dy))) continue;
        seen.add(k);
        q.push(k);
      }
    }
    return seen;
  };
  let id = 0;
  for (const k of floor) {
    if (comp.has(k)) continue;
    id += 1;
    for (const c of flood(k, false)) comp.set(c, id);
  }
  return { floor, solid, doors, comp, flood, blockedBy, fractional: solid.fractional + doors.fractional };
}

const outsideCell = (d, outward) => {
  // door wall `d.c`; the cell on the corridor side. horizontal door: below (`south` exit) or above (`north` reveal);
  // vertical door: east (exit) or west (reveal).
  const [x1, y1, x2] = d.c.map((n) => n / CELL);
  const horizontal = d.c[1] === d.c[3];
  const cx = Math.floor(Math.min(x1, x2) + 1e-9);
  const cy = Math.floor(y1 + 1e-9);
  if (horizontal) return outward === 'out' ? ck(cx, cy) : ck(cx, cy - 1);
  return outward === 'out' ? ck(cx, cy) : ck(cx - 1, cy);
};

/**
 * Walkability of every real edge of `layout` (`layout.edges`) in `scene`. Returns
 * `{ edges: Map(key -> { from, to, walkable, cause, nullPath }), dead: Set(key), model }`.
 * `cause` (dead only): `missingDoor`, `sealedDoor` (a solid wall covers a door unit), `noStartTile` / `noEndTile`
 * (no corridor floor on the door's corridor-side cell), `wallCut` (the tiles are connected only through a wall:
 * flank/margin/corridor walls cross the corridor), `tileGap` (not connected even ignoring walls).
 */
export function edgeWalkability(layout, scene, { includeHidden = false } = {}) {
  const model = buildWalkModel(scene);
  const flagOf = (w) => w.flags?.[MODULE_ID] ?? {};
  const edges = new Map();
  const pairs = [];
  for (const [from, kids] of Object.entries(layout.edges)) for (const to of kids) pairs.push({ from, to, hidden: false });
  if (includeHidden) for (const [from, kids] of Object.entries(layout.hiddenEdges ?? {})) for (const to of kids.slice(0, 1)) pairs.push({ from, to, hidden: true });
  for (const { from, to, hidden } of pairs) {
    const key = `${from}->${to}`;
    const plan = outgoingDoorPlan(layout.rect[from], layout.pos[from], {
      realChildIds: layout.edges[from] ?? [], hiddenChildIds: (layout.hiddenEdges[from] ?? []).slice(0, 1),
    }, layout.pos);
    const nullPath = !findCorridorPath(layout.pos[from], layout.pos[to], layout.occ, {
      fromRoomId: from, toRoomId: to, incomingFace: layout.incFace[to], exitFace: plan.get(to)?.face,
    });
    const out = scene.walls.find((w) => w.door && (hidden
      ? flagOf(w).dungeonHiddenDoorForEdge === key && flagOf(w).dungeonHiddenDoorRole === 'gate'
      : flagOf(w).dungeonDoorToRoomId === to && flagOf(w).dungeonDoorFromRoomId === from));
    const rev = scene.walls.find((w) => w.door && (hidden
      ? flagOf(w).dungeonHiddenDoorForEdge === key && flagOf(w).dungeonHiddenDoorRole === 'reveal'
      : flagOf(w).dungeonRevealDoorForSlot === to && flagOf(w).dungeonDoorFromRoomId === from));
    const rec = { from, to, hidden, nullPath, walkable: false, cause: null };
    edges.set(key, rec);
    if (!out || !rev) { rec.cause = 'missingDoor'; continue; }
    const covered = (d) => {
      const one = unitEdges([d]);
      for (const [k, list] of one.v) if (model.solid.v.has(k) && list) return true;
      for (const [k, list] of one.h) if (model.solid.h.has(k) && list) return true;
      return false;
    };
    if (covered(out) || covered(rev)) { rec.cause = 'sealedDoor'; continue; }
    const s = outsideCell(out, 'out');
    const t = outsideCell(rev, 'rev');
    if (!model.floor.has(s)) { rec.cause = 'noStartTile'; continue; }
    if (!model.floor.has(t)) { rec.cause = 'noEndTile'; continue; }
    if (model.comp.get(s) === model.comp.get(t)) { rec.walkable = true; continue; }
    rec.cause = model.flood(s, true).has(t) ? 'wallCut' : 'tileGap';
  }
  return { edges, dead: new Set([...edges].filter(([, e]) => !e.walkable).map(([k]) => k)), model };
}

/** Flood from room-entry over `layout.edges` skipping dead edges: `{ goal, unreachable: [roomId] }`. */
export function walkableVerdict(layout, dead) {
  const seen = new Set(['room-entry']);
  const q = ['room-entry'];
  while (q.length) {
    const x = q.shift();
    for (const c of layout.edges[x] ?? []) if (!seen.has(c) && !dead.has(`${x}->${c}`)) { seen.add(c); q.push(c); }
  }
  return {
    goal: seen.has('room-goal'),
    unreachable: Object.keys(layout.rooms).filter((r) => !seen.has(r) && !layout.hiddenRooms.includes(r)),
  };
}

/** A `computeRunLayout` result (scripts/dungeon-reseed.mjs) in the sweep-layout shape the oracles read. */
export function sweepShapeOfRunLayout(P) {
  const pos = P.layoutPositionByRoomId;
  return {
    seed: P.seed, rooms: P.rooms, edges: P.edges, hiddenEdges: P.hiddenEdges, hiddenRooms: P.hiddenRooms, layoutEdges: P.layoutEdges,
    hiddenIncomingByRoomId: P.hiddenIncomingByRoomId, pos, occ: P.occupiedCells, incFace: P.incomingFaceByRoomId,
    ...(P.stubEdges ? { stubEdges: P.stubEdges } : {}),
    rect: Object.fromEntries(Object.keys(P.rooms).map((id) => [id, roomRect(P.seed, id, pos[id].rank, pos[id].col)])),
  };
}

export { buildSceneForLayout };
