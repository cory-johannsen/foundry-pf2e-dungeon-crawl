// tests/helpers/passage-prototype.mjs
// #427 Phase 4 PROTOTYPE (test-only, grounds the design note's numbers; ships nothing, changes no behavior).
//
// Question it answers: for the edges that today have NO grid path (and whose fallback line overlaps an
// intermediate room), is there a one-tile-wide lane through FREE unit tiles (outside every room rect, off
// every found edge's floor, off every other door's mouth) from the source door's outside tile to the
// target door's outside tile? Free tiles include the east/south margin rails of occupied cells, which is
// exactly the space a "margin-lane pass-through" would use. Edges are routed in canonical order (target
// rank, target id, source id) and each placed lane becomes an obstacle for the next, so a served count is
// an achievable simultaneous assignment, not an optimistic per-edge bound.
//
// Model limits (honest): obstacles are the layoutVersion 2 floors of edges that HAVE a path (a v3 router
// re-routes ~36 of them and drops ~185 unresolvable ones into this class); lanes are 1 tile wide, may
// touch another floor only across a shared wall (the same flank-wall construction the router assumes);
// walls are not generated here. Search is a turn-penalised Dijkstra (straight lanes preferred), bounded
// to the source/target cell box plus `boxMargin` cells.
import { findCorridorPath, cellBounds } from '../../scripts/dungeon-layout.mjs';
import { visitEdges } from './buildability.mjs';

const area = (a, b) => Math.max(0, Math.min(a.gx + a.gw, b.gx + b.gw) - Math.max(a.gx, b.gx))
  * Math.max(0, Math.min(a.gy + a.gh, b.gy + b.gh) - Math.max(a.gy, b.gy));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const key = (x, y) => `${x},${y}`;
const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];

function tilesOf(rects) {
  const out = [];
  for (const r of rects) for (let x = r.gx; x < r.gx + r.gw; x += 1) for (let y = r.gy; y < r.gy + r.gh; y += 1) out.push(key(x, y));
  return out;
}

function mouthTiles(sel, face, res) {
  const d = res.doorWall; const r = res.revealDoorWall;
  const src = sel.face === 'west' ? { x: d.x1 - 1, y: d.y1 } : { x: d.x1, y: d.y1 };
  const dst = face === 'west' ? { x: r.x1 - 1, y: r.y1 } : { x: r.x1, y: r.y1 - 1 };
  return { src, dst };
}

/** `relax.slim` (hypothetical v3 geometry): a fast-path rectangle (a single misaligned-door blob, up to
 * 5x7 in the sweep) is replaced by the 1-wide L between its two door mouths, jogging in the first row
 * below/right of the source door. Chains and corner connectors are already 1 wide and are kept as drawn. */
function slimTiles(e) {
  if (e.res.transitCells.length || e.res.corridorSegments.length !== 1) return tilesOf(e.segs);
  const [a, b] = [e.src, e.dst]; const out = [];
  const vertical = e.sel.face === 'south';
  if (vertical) {
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x += 1) out.push(key(x, a.y));
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y += 1) out.push(key(b.x, y));
  } else {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y += 1) out.push(key(a.x, y));
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x += 1) out.push(key(x, b.y));
  }
  return out;
}

/** Turn-penalised Dijkstra on the unit grid; deterministic (fixed neighbour order, insertion-order ties). */
function route(start, end, blocked, bounds, { turnCost = 3, maxCost = 400 } = {}) {
  const dist = new Map(); const prev = new Map();
  const heap = []; let seq = 0;
  const push = (c, s, k) => { heap.push([c, seq += 1, s, k]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (cmp(heap[p][0] * 1e6 + heap[p][1], heap[i][0] * 1e6 + heap[i][1]) <= 0) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < heap.length && heap[l][0] * 1e6 + heap[l][1] < heap[m][0] * 1e6 + heap[m][1]) m = l; if (r < heap.length && heap[r][0] * 1e6 + heap[r][1] < heap[m][0] * 1e6 + heap[m][1]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const sk = (x, y, d) => `${x},${y},${d}`;
  for (let d = 0; d < 4; d += 1) { dist.set(sk(start.x, start.y, d), 0); push(0, { x: start.x, y: start.y, d }, sk(start.x, start.y, d)); }
  while (heap.length) {
    const [c, , s, k] = pop();
    if (c > dist.get(k)) continue;
    if (c > maxCost) return null;
    if (s.x === end.x && s.y === end.y) {
      const tiles = []; let cur = k;
      while (cur) { const [x, y] = cur.split(',').map(Number); tiles.push({ x, y }); cur = prev.get(cur); }
      return tiles.reverse().filter((t, i, a) => i === 0 || t.x !== a[i - 1].x || t.y !== a[i - 1].y);
    }
    for (let d = 0; d < 4; d += 1) {
      const nx = s.x + DIRS[d][0]; const ny = s.y + DIRS[d][1];
      if (nx < bounds.x0 || nx >= bounds.x1 || ny < bounds.y0 || ny >= bounds.y1) continue;
      if (blocked.has(key(nx, ny)) && !(nx === end.x && ny === end.y)) continue;
      const nc = c + 1 + (d === s.d ? 0 : turnCost);
      const nk = sk(nx, ny, d);
      if (nc < (dist.get(nk) ?? Infinity)) { dist.set(nk, nc); prev.set(nk, k); push(nc, { x: nx, y: ny, d }, nk); }
    }
  }
  return null;
}

export const ZERO_PASSAGE = () => ({
  edges: 0, boxedIn: 0, boxedInOverlap: 0, served: 0, servedOverlap: 0, residual: 0, residualOverlap: 0,
  forcedTotal: 0, forcedServed: 0, noMouth: 0, tilesTotal: 0, tilesDirect: 0, overlapsOwnRooms: 0, maxTiles: 0, over60: 0, over100: 0,
  turnsTotal: 0, occupiedCellsCrossed: 0, laneInOccupiedMargin: 0, blockedByStartEnd: 0,
  fixpointIterations: 0, lineLaneConflictsFirstPass: 0, pinnedLines: 0,
});
export const sumPassage = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k === 'maxTiles' ? Math.max(a[k] ?? 0, b[k] ?? 0) : (a[k] ?? 0) + (b[k] ?? 0)]));

/** @param {object} layout from buildSweepLayout. Returns counts plus per-edge results when `detail` is set. */
export function measurePassages(layout, { boxMargin = 1, turnCost = 3, maxCost = 400, detail = false, extraFoundIds = null, relax = {}, slotOrder = 'plan', scope = 'overlap' } = {}) {
  const out = ZERO_PASSAGE();
  const edges = [];
  // Passage targets: null-path edges whose fallback line overlaps an intermediate room, plus (extraFoundIds)
  // router-unresolvable edges. Every other edge keeps its drawn floor (found edges, #297 doglegs and the
  // null fallbacks that miss every room) as an obstacle.
  // scope 'allNull': every null-path edge is a target (the 920 harmless fallback lines too), overlapping ones first.
  const isTarget = (e) => (e.null && (scope === 'allNull' || e.overlapRoom)) || e.forced;
  visitEdges(layout, ({ sourceId, toId, face, sel, res }) => {
    const path = findCorridorPath(layout.pos[sourceId], layout.pos[toId], layout.occ,
      { fromRoomId: sourceId, toRoomId: toId, incomingFace: face, exitFace: sel.face });
    const segs = [...res.corridorSegments, ...res.transitCells.flatMap((c) => c.corridorSegments)];
    const overlapRoom = Object.entries(layout.rect).some(([id, r]) => id !== sourceId && id !== toId && segs.some((s) => area(s, r) > 0));
    // `extraFoundIds` (optional Set of "src->to"): edges the topology router could not place; they are
    // boxed-in class in layoutVersion 3 and their v2 floor is NOT an obstacle.
    const forced = extraFoundIds?.has(`${sourceId}->${toId}`) ?? false;
    edges.push({ sourceId, toId, face, sel, res, segs, null: !path || forced, overlapRoom, forced, ...mouthTiles(sel, face, res) });
  }, { slotOrder });
  out.edges = edges.length;
  const roomT = new Set(tilesOf(Object.values(layout.rect)));
  const floorT = new Set(); const mouthT = new Set();
  for (const e of edges) {
    if (!isTarget(e) && !relax.floors && !(relax.dropNullLines && e.null)) for (const t of (relax.slim ? slimTiles(e) : tilesOf(e.segs))) floorT.add(t);
    // every door's mouth is that edge's own floor: reserved against all other lanes
    if (!relax.mouths) { mouthT.add(key(e.src.x, e.src.y)); mouthT.add(key(e.dst.x, e.dst.y)); }
  }
  const targets = edges.filter(isTarget)
    .sort((a, b) => (Number(b.overlapRoom) - Number(a.overlapRoom)) || (layout.pos[a.toId].rank - layout.pos[b.toId].rank) || cmp(a.toId, b.toId) || cmp(a.sourceId, b.sourceId));

  // One routing pass. `lineT` holds the fallback-line tiles of targets already known to stay UNSERVED: that
  // line is still drawn in the scene (a counted residual), so no later lane may cross it.
  const runPass = (lineT, withCauses) => {
    const run = ZERO_PASSAGE(); run.edges = out.edges;
    const laneT = new Set();
    const blocked = { has: (k) => roomT.has(k) || floorT.has(k) || mouthT.has(k) || laneT.has(k) || lineT.has(k) };
    const unserved = [];
    for (const e of targets) {
      e.lane = null; e.cause = undefined;
      run.boxedIn += 1; if (e.overlapRoom) run.boxedInOverlap += 1; if (e.forced) run.forcedTotal += 1;
      const ps = layout.pos[e.sourceId]; const pt = layout.pos[e.toId];
      const lo = cellBounds(Math.min(ps.rank, pt.rank) - boxMargin, Math.min(ps.col, pt.col) - boxMargin);
      const hi = cellBounds(Math.max(ps.rank, pt.rank) + boxMargin, Math.max(ps.col, pt.col) + boxMargin);
      const bounds = relax.bounds ? { x0: -1e4, y0: -1e4, x1: 1e4, y1: 1e4 } : { x0: lo.gx, y0: lo.gy, x1: hi.gx + hi.gw, y1: hi.gy + hi.gh };
      const lane = route(e.src, e.dst, blocked, bounds, { turnCost, maxCost });
      if (!lane) {
        unserved.push(e);
        run.residual += 1; if (e.overlapRoom) run.residualOverlap += 1;
        if (withCauses) {
          // Cause waterfall: the first relaxation (cumulative) that makes the edge routable.
          const sets = [['order', (k) => roomT.has(k) || floorT.has(k) || mouthT.has(k) || lineT.has(k)], ['mouths', (k) => roomT.has(k) || floorT.has(k) || lineT.has(k)],
            ['floors', (k) => roomT.has(k)], ['roomsOnly', (k) => roomT.has(k)]];
          let cause = 'unreachable';
          for (const [name, has] of sets) {
            if (name === 'roomsOnly') { if (route(e.src, e.dst, { has }, { x0: bounds.x0 - 26, y0: bounds.y0 - 26, x1: bounds.x1 + 26, y1: bounds.y1 + 26 }, { turnCost, maxCost })) cause = 'boxMargin'; break; }
            if (route(e.src, e.dst, { has }, bounds, { turnCost, maxCost })) { cause = name; break; }
          }
          run[`cause_${cause}`] = (run[`cause_${cause}`] ?? 0) + 1;
          if (e.overlapRoom) run[`causeOverlap_${cause}`] = (run[`causeOverlap_${cause}`] ?? 0) + 1;
          e.cause = cause;
        }
        continue;
      }
      run.served += 1; if (e.overlapRoom) run.servedOverlap += 1; if (e.forced) run.forcedServed += 1;
      run.tilesTotal += lane.length; run.maxTiles = Math.max(run.maxTiles, lane.length);
      if (lane.length > 60) run.over60 += 1; if (lane.length > 100) run.over100 += 1;
      run.tilesDirect += Math.abs(e.src.x - e.dst.x) + Math.abs(e.src.y - e.dst.y) + 1;
      for (let i = 2; i < lane.length; i += 1) {
        if ((lane[i].x - lane[i - 1].x) !== (lane[i - 1].x - lane[i - 2].x) || (lane[i].y - lane[i - 1].y) !== (lane[i - 1].y - lane[i - 2].y)) run.turnsTotal += 1;
      }
      const cells = new Set();
      for (const t of lane) {
        laneT.add(key(t.x, t.y));
        const cx = Math.floor((t.x - cellBounds(0, 0).gx) / 13); const cy = Math.floor((t.y - cellBounds(0, 0).gy) / 13);
        if (layout.occ[`${cy},${cx}`] != null) cells.add(`${cy},${cx}`);
      }
      run.occupiedCellsCrossed += cells.size; if (cells.size) run.laneInOccupiedMargin += 1;
      if (Object.entries(layout.rect).some(([id, r]) => lane.some((t) => t.x >= r.gx && t.x < r.gx + r.gw && t.y >= r.gy && t.y < r.gy + r.gh && id !== undefined))) run.overlapsOwnRooms += 1;
      e.lane = lane;
    }
    return { run, unserved, laneT };
  };

  // Fixed point: an unserved target keeps its fallback line, so any lane that crosses that line is invalid.
  // Add such lines as obstacles and re-route (the obstacle set only grows, so this terminates).
  const lineT = new Set(); const pinned = new Set();
  let first = null; let result; let iterations = 0;
  for (let iter = 0; iter < 25; iter += 1) {
    result = runPass(lineT, false);
    iterations = iter + 1;
    const conflicting = result.unserved.filter((e) => !pinned.has(e) && tilesOf(e.segs).some((t) => result.laneT.has(t)));
    if (first === null) first = { edges: conflicting.length, unservedTotal: result.unserved.length };
    if (!conflicting.length) break;
    for (const e of conflicting) { pinned.add(e); for (const t of tilesOf(e.segs)) lineT.add(t); }
  }
  // Final pass with the cause waterfall on the converged obstacle set (deterministic, same result).
  result = runPass(lineT, true);
  Object.assign(out, result.run, { fixpointIterations: iterations, lineLaneConflictsFirstPass: first.edges, pinnedLines: pinned.size });
  void detail;
  return detail ? { out, edges } : out;
}
