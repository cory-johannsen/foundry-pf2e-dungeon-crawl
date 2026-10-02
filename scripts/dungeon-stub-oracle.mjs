/**
 * #427 Chunk 7 / #490 / #575: which real edges of a BUILT (scratch) scene a token can actually walk, and the stub plan
 * that turns the ones it cannot into rubble-capped dead ends.
 *
 * Dead-edge semantics, one set of `from->to` keys each (real, non-hidden edges of `layout.edges`):
 *   opt     a door is sealed by a solid wall (a null-path fallback with open doors counts LIVE)
 *   strict  sealed OR null-path fallback
 *   truth   sealed OR a null-path fallback whose centre line crosses a solid wall
 *   union   truth OR (#575) the edge is not walkable door to door over the corridor floor (found-path corridors cut
 *           by a sibling's flank or a margin wall, tile gaps, missing doors). THE product predicate.
 * `planStubsVerified` plans stubs against the `union`, then verifies on a freshly built scene that no semantics lost
 * the goal or a room the stub-free scene reached (door re-slotting can seal a different edge; no pre-scene predicate
 * can see that), dropping stubs until none does. tests/helpers/stub-union.mjs and walkability-oracle.mjs are the
 * independent test-side oracles these must agree with (tests/dungeon-stub-oracle.test.mjs).
 * #585: every dead edge the stub plan could not turn into a stub is WALLED (`walledEdges`): no door, no corridor, a solid
 * face where the door would be, and out of `edges`. Walling removes doors, which re-slots siblings and can kill another
 * edge, so `planStubsVerified` repeats (re-place the stubs, rebuild, wall what is dead) until no live real edge is dead.
 */
import {
  roomRect, outgoingDoorPlan, findCorridorPath, stubStateFor, applyStubsToEdges, planStubGeometries, mergeEdgeMaps,
} from './dungeon-layout.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const GRID = 100;

export const SEMANTICS = ['opt', 'strict', 'truth', 'union'];

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

const cellKey = (cx, cy) => `${cx},${cy}`;

// Unit wall edges a set of walls occupies: 'v:x,y' sits between cells (x-1,y) and (x,y), 'h:x,y' between (x,y-1) and
// (x,y). A wall covering even part of a unit edge blocks all of it (half-cell flank walls exist).
function unitEdgeKeys(walls) {
  const keys = new Set();
  for (const w of walls) {
    const [a, b, c, e] = w.c.map((n) => n / GRID);
    if (a === c) {
      for (let y = Math.floor(Math.min(b, e) + 1e-9); y < Math.ceil(Math.max(b, e) - 1e-9); y += 1) keys.add(`v:${Math.round(a)},${y}`);
    } else {
      for (let x = Math.floor(Math.min(a, c) + 1e-9); x < Math.ceil(Math.max(a, c) - 1e-9); x += 1) keys.add(`h:${x},${Math.round(b)}`);
    }
  }
  return keys;
}

// The cell on the corridor side of door wall `d`: `out` for an outgoing door (below / east), else a reveal door (above / west).
function doorCorridorCell(d, out) {
  const cx = Math.floor(Math.min(d.c[0], d.c[2]) / GRID + 1e-9);
  const cy = Math.floor(d.c[1] / GRID + 1e-9);
  if (d.c[1] === d.c[3]) return out ? cellKey(cx, cy) : cellKey(cx, cy - 1);
  return out ? cellKey(cx, cy) : cellKey(cx - 1, cy);
}

/**
 * #575: the real edges whose doors a token cannot walk between. Flood the corridor TILE floor with every solid wall
 * and every door as a blocker; an edge is walkable when the cell just outside its outgoing door and the cell just
 * outside its reveal door share a floor component and neither door is covered by a solid wall.
 */
function unwalkableEdges(layout, scene) {
  const floor = new Set();
  for (const t of scene.tiles) {
    const w = Math.max(1, Math.round((t.width ?? GRID) / GRID));
    const h = Math.max(1, Math.round((t.height ?? GRID) / GRID));
    const x0 = Math.round((t.x - (t.width ?? GRID) / 2) / GRID);
    const y0 = Math.round((t.y - (t.height ?? GRID) / 2) / GRID);
    for (let i = 0; i < w; i += 1) for (let j = 0; j < h; j += 1) floor.add(cellKey(x0 + i, y0 + j));
  }
  const solid = unitEdgeKeys(scene.walls.filter((w) => !w.door));
  const doors = unitEdgeKeys(scene.walls.filter((w) => w.door));
  const edgeBetween = (x, y, nx, ny) => (x !== nx ? `v:${Math.max(x, nx)},${y}` : `h:${x},${Math.max(y, ny)}`);
  const comp = new Map();
  let id = 0;
  for (const start of floor) {
    if (comp.has(start)) continue;
    id += 1;
    comp.set(start, id);
    const stack = [start];
    while (stack.length) {
      const [x, y] = stack.pop().split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = cellKey(x + dx, y + dy);
        if (comp.has(k) || !floor.has(k)) continue;
        if (solid.has(edgeBetween(x, y, x + dx, y + dy)) || doors.has(edgeBetween(x, y, x + dx, y + dy))) continue;
        comp.set(k, id);
        stack.push(k);
      }
    }
  }
  const flag = (w) => w.flags?.[MODULE_ID] ?? {};
  const bad = new Set();
  for (const [from, kids] of Object.entries(layout.edges)) {
    for (const to of kids) {
      const out = scene.walls.find((w) => w.door && flag(w).dungeonDoorToRoomId === to && flag(w).dungeonDoorFromRoomId === from);
      const rev = scene.walls.find((w) => w.door && flag(w).dungeonRevealDoorForSlot === to && flag(w).dungeonDoorFromRoomId === from);
      const sealed = (d) => [...unitEdgeKeys([d])].some((k) => solid.has(k));
      const s = out && doorCorridorCell(out, true);
      const t = rev && doorCorridorCell(rev, false);
      if (!out || !rev || sealed(out) || sealed(rev) || !floor.has(s) || !floor.has(t) || comp.get(s) !== comp.get(t)) bad.add(edgeKey(from, to));
    }
  }
  return bad;
}

/**
 * The dead real edges of `layout` in built `scene`, under every semantics: `{ opt, strict, truth, union }`, each a
 * `Set` of `from->to`. `layout` is a run layout (`computeRunLayout`'s shape; stubs, if any, are already out of
 * `layout.edges`).
 */
export function deadEdgeSets(layout, scene) {
  const solid = scene.walls.filter((w) => !w.door);
  const sealed = new Set();
  for (const d of scene.walls.filter((w) => w.door)) {
    const f = d.flags?.[MODULE_ID] ?? {};
    if (f.dungeonHiddenDoorForEdge) continue; // detour/shortcut doors are not progression edges
    const to = f.dungeonDoorToRoomId ?? f.dungeonRevealDoorForSlot;
    if (to && solid.some((w) => overlapsOnLine(w, d))) sealed.add(edgeKey(f.dungeonDoorFromRoomId, to));
  }
  const pos = layout.layoutPositionByRoomId;
  const strict = new Set(sealed);
  const truth = new Set(sealed);
  for (const [from, kids] of Object.entries(layout.edges)) {
    const plan = outgoingDoorPlan(roomRect(layout.seed, from, pos[from].rank, pos[from].col), pos[from], {
      realChildIds: kids, hiddenChildIds: (layout.hiddenEdges[from] ?? []).slice(0, 1),
    }, pos);
    for (const to of kids) {
      const path = findCorridorPath(pos[from], pos[to], layout.occupiedCells, {
        fromRoomId: from, toRoomId: to, incomingFace: layout.incomingFaceByRoomId[to], exitFace: plan.get(to)?.face,
      });
      if (path) continue;
      strict.add(edgeKey(from, to));
      if (!centreLineClear(scene, from, to)) truth.add(edgeKey(from, to));
    }
  }
  const union = new Set([...truth, ...unwalkableEdges(layout, scene)]);
  return { opt: sealed, strict, truth, union };
}

/** Flood from room-entry over `layout.edges` skipping `dead` keys: `{ goal, unreachable: [roomId] }` (hidden rooms excluded). */
function verdictFor(layout, dead) {
  const seen = new Set(['room-entry']);
  const queue = ['room-entry'];
  while (queue.length) {
    const x = queue.shift();
    for (const c of layout.edges[x] ?? []) if (!seen.has(c) && !dead.has(edgeKey(x, c))) { seen.add(c); queue.push(c); }
  }
  return {
    goal: seen.has('room-goal'),
    unreachable: Object.keys(layout.rooms).filter((r) => !seen.has(r) && !layout.hiddenRooms.includes(r)),
  };
}

/** `{ opt, strict, truth, union }` verdicts `{ goal, unreachable: [roomId] }` for the dead sets of `deadEdgeSets`. */
export function verdictsOf(layout, sets) {
  return Object.fromEntries(SEMANTICS.map((s) => [s, verdictFor(layout, sets[s])]));
}

/** Does `next` lose the goal, or a room that the stub-free `base` reached, under ANY semantics? */
export function regressesAny(base, next) {
  return SEMANTICS.some((s) => (base[s].goal && !next[s].goal) || next[s].unreachable.some((r) => !base[s].unreachable.includes(r)));
}

const toKeys = (stubEdges) => new Set(Object.entries(stubEdges).flatMap(([s, ts]) => ts.map((t) => edgeKey(s, t))));
const fromKeys = (set) => {
  const o = {};
  for (const x of [...set].sort()) { const [s, t] = x.split('->'); (o[s] ??= []).push(t); }
  return o;
};

/**
 * #427 Chunk 7: plan the stubs of stub-free run layout `layout` (layoutVersion >= 3), judged on the scene.
 * `buildScene(layout)` resolves to a scratch scene built for that layout (its `stubEdges` honoured). Steps:
 *   1. build the stub-free scene; its `union` dead real edges are the stub candidates;
 *   2. `stubStateFor` with those `deadEdges`: graph rules 1 and 3, retreat replacing rule 2, rule 3' (live reach must
 *      not shrink), then geometry (a stub with no free door tile is dropped);
 *   3. verify: build the stubbed scene and, while any semantics regresses against the stub-free baseline, drop the
 *      first stub (canonical order) whose removal alone clears it, else the last; the remaining stubs are re-placed
 *      after every drop so each stored stub is buildable.
 * Returns `{ layout (stubs applied: `edges` without them, `stubEdges`), base, verdicts, deadSets, dropped }`;
 * `verdicts` are those of the final stubbed scene.
 */
export async function planStubsVerified({ layout, buildScene, retreatAvailable }) {
  const baseSets = deadEdgeSets(layout, await buildScene(layout));
  const base = verdictsOf(layout, baseSets);
  const deadEdges = [...baseSets.union].map((k) => { const [sourceId, toId] = k.split('->'); return { sourceId, toId }; });
  const positionByRoomId = layout.layoutPositionByRoomId;
  const inputs = {
    seed: layout.seed, rooms: layout.rooms, positionByRoomId, occupiedCells: layout.occupiedCells, edges: layout.edges,
    layoutEdges: layout.layoutEdges, hiddenEdges: layout.hiddenEdges, hiddenRooms: layout.hiddenRooms,
    hiddenIncomingByRoomId: layout.hiddenIncomingByRoomId, incomingFaceByRoomId: layout.incomingFaceByRoomId,
  };
  const planned = stubStateFor(3, inputs, { retreatAvailable, deadEdges }).stubEdges ?? {};
  const placeable = (set, walled = new Set()) => {
    const kept = new Set(set);
    for (;;) {
      const se = fromKeys(kept);
      if (!Object.keys(se).length) return kept;
      const placed = planStubGeometries({ ...inputs, edges: applyStubsToEdges(inputs.edges, fromKeys(walled)), stubEdges: se, walledEdges: fromKeys(walled) });
      if (!placed.infeasible.length) return kept;
      kept.delete([...placed.infeasible].sort()[0]);
    }
  };
  const stubbed = (set, walled = new Set()) => {
    const stubEdges = fromKeys(set);
    const walledEdges = fromKeys(walled);
    return {
      ...layout, edges: applyStubsToEdges(layout.edges, mergeEdgeMaps(stubEdges, walledEdges)), stubEdges,
      ...(walled.size ? { walledEdges } : {}),
    };
  };
  const evalSet = async (set) => {
    const L = stubbed(set);
    const sets = deadEdgeSets(L, await buildScene(L));
    return { L, sets, verdicts: verdictsOf(L, sets) };
  };
  let kept = placeable(toKeys(planned));
  let cur = await evalSet(kept);
  let dropped = 0;
  while (regressesAny(base, cur.verdicts) && kept.size) {
    const list = [...kept].sort();
    let pick = null;
    for (const x of list) {
      const t = placeable(new Set([...kept].filter((y) => y !== x)));
      const next = await evalSet(t);
      if (!regressesAny(base, next.verdicts)) { pick = { t, next }; break; }
    }
    if (!pick) {
      const t = placeable(new Set(list.slice(0, -1)));
      pick = { t, next: await evalSet(t) };
    }
    kept = pick.t; cur = pick.next; dropped += 1;
  }
  // #585: wall what is still dead. Each pass re-places the stubs against the walled set (a stub whose door tile the
  // re-slotting took away is dead too, so it is walled instead), rebuilds, and walls the new dead edges, until none is.
  const settle = async (start, startFin) => {
    const walledSet = new Set();
    let stubSet = start;
    let last = startFin ?? await evalSet(stubSet);
    for (let pass = 0; pass < 50; pass += 1) {
      const before = walledSet.size;
      for (const k of last.sets.union) walledSet.add(k);
      if (walledSet.size === before && pass > 0) break;
      const placedSet = placeable(stubSet, walledSet);
      for (const x of stubSet) if (!placedSet.has(x)) walledSet.add(x);
      stubSet = placedSet;
      const L = stubbed(stubSet, walledSet);
      const sets = deadEdgeSets(L, await buildScene(L));
      last = { L, sets, verdicts: verdictsOf(L, sets) };
    }
    return { fin: last, walledSet, stubSet };
  };
  // The union verdict is the product's (walling removes edges the optimistic semantics still call live).
  const lostUnion = (v) => (base.union.goal && !v.union.goal) || v.union.unreachable.some((r) => !base.union.unreachable.includes(r));
  // Walling removes doors and re-slots siblings, which can kill an edge that was walkable before: `lost` reports whether
  // that cost the goal or a room the stub-free scene reached (1 of 500 measured seeds, a dungeon whose goal is
  // unreachable anyway; the reseed rejects it). Giving up a stub did not repair it (measured), so no repair is attempted.
  const res = await settle(kept, cur);
  const fin = res.fin;
  const walled = res.walledSet;
  return { layout: fin.L, base, verdicts: fin.verdicts, deadSets: fin.sets, dropped, baseDead: baseSets.union, walled: walled.size, lost: lostUnion(fin.verdicts) };
}
