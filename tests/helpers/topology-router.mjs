// tests/helpers/topology-router.mjs
// #427 PROTOTYPE (test-only): a sequential, topology-aware router. Edges are routed one at a time in a
// canonical order; an edge whose shortest chain cannot be given non-crossing lanes against everything
// already placed is re-routed around the cells that made it fail (blocked-cell search over
// buildEdgeCorridor's own `occupiedCells` argument), up to a try budget. No scripts/ change.
import { cellBounds, transitCellCrossing, transitCellContainmentWalls } from '../../scripts/dungeon-layout.mjs';
import { visitEdges } from './buildability.mjs';
import { chainFromResult, makePlacer } from './lane-prototype.mjs';

const area = (a, b) => Math.max(0, Math.min(a.gx + a.gw, b.gx + b.gw) - Math.max(a.gx, b.gx))
  * Math.max(0, Math.min(a.gy + a.gh, b.gy + b.gh) - Math.max(a.gy, b.gy));
const cuts = (w, f) => (w.y1 === w.y2
  ? f.gy < w.y1 && w.y1 < f.gy + f.gh && Math.max(Math.min(w.x1, w.x2), f.gx) < Math.min(Math.max(w.x1, w.x2), f.gx + f.gw)
  : f.gx < w.x1 && w.x1 < f.gx + f.gw && Math.max(Math.min(w.y1, w.y2), f.gy) < Math.min(Math.max(w.y1, w.y2), f.gy + f.gh));
const SIDE = {
  north: (c, v) => ({ x: v, y: c.gy }), south: (c, v) => ({ x: v, y: c.gy + c.gh }),
  west: (c, v) => ({ x: c.gx, y: v }), east: (c, v) => ({ x: c.gx + c.gw, y: v }),
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (a, b) => (a.targetRank - b.targetRank) || cmp(a.toId, b.toId) || cmp(a.sourceId, b.sourceId);

export const ZERO_ROUTE = () => ({
  edges: 0, multi: 0, placedFirst: 0, rerouted: 0, unresolvable: 0, tries: 0, newInterOverlap: 0,
  baseCells: 0, extraCells: 0, longer1: 0, longer2: 0, longer3plus: 0, maxExtra: 0,
  placedFloorCrossings: 0, placedCutOccurrences: 0, maxLoad: 0, blobs: 0,
});
export const sumRoutes = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, k === 'maxExtra' || k === 'maxLoad' ? Math.max(a[k], b[k]) : a[k] + b[k]]));

export function routeLayoutTopologyAware(layout, { maxTries = 40, order = 'canonical' } = {}) {
  const out = ZERO_ROUTE();
  const specs = [];
  visitEdges(layout, ({ sourceId, toId, res, build }) => {
    out.edges += 1;
    const chain = chainFromResult(layout, sourceId, toId, res);
    if (chain) specs.push({ sourceId, toId, targetRank: layout.pos[toId].rank, build, baseChain: chain });
  });
  specs.sort(order === 'reverse' ? (a, b) => canonical(b, a)
    : order === 'longestFirst' ? (a, b) => (b.baseChain.cells.length - a.baseChain.cells.length) || canonical(a, b)
    : order === 'shortestFirst' ? (a, b) => (a.baseChain.cells.length - b.baseChain.cells.length) || canonical(a, b) : canonical);
  out.multi = specs.length;
  const placer = makePlacer();
  const uses = new Map(); // "rank,col" -> [{ id, floors, plainWalls, openings }]
  const otherRects = (a, b) => Object.entries(layout.rect).filter(([id]) => id !== a && id !== b).map(([, r]) => r);

  for (const spec of specs) {
    const seen = new Set(['']);
    const queue = [[]];
    let tries = 0; let done = false;
    while (queue.length && !done && tries <= maxTries) {
      const blocked = queue.shift();
      tries += 1;
      const occ = { ...layout.occ };
      for (const k of blocked) occ[k] = '__blocked';
      const res = spec.build(occ);
      const chain = chainFromResult(layout, spec.sourceId, spec.toId, res);
      if (!chain) continue; // blocked into a null path (direct-line fallback): not a routed candidate
      const segs = [...res.corridorSegments, ...res.transitCells.flatMap((c) => c.corridorSegments)];
      if (otherRects(spec.sourceId, spec.toId).some((r) => segs.some((s) => area(s, r) > 0))) {
        if (blocked.length) { out.newInterOverlap += 1; continue; }
      }
      if (placer.tryPlace(chain)) {
        done = true;
        const extra = chain.cells.length - spec.baseChain.cells.length;
        if (blocked.length === 0) out.placedFirst += 1; else out.rerouted += 1;
        out.baseCells += spec.baseChain.cells.length; out.extraCells += extra;
        if (extra === 1) out.longer1 += 1; else if (extra === 2) out.longer2 += 1; else if (extra >= 3) out.longer3plus += 1;
        out.maxExtra = Math.max(out.maxExtra, extra);
        const coords = placer.placed.get(chain.id);
        chain.cells.forEach((c, i) => {
          const cell = cellBounds(c.rank, c.col);
          const cr = transitCellCrossing(chain.seed, c.rank, c.col, c.entrySide, c.exitSide, chain.id, {
            forcedEntryPoint: SIDE[c.entrySide](cell, coords[i]), forcedExitPoint: SIDE[c.exitSide](cell, coords[i + 1]),
          });
          const key = `${c.rank},${c.col}`;
          if (!uses.has(key)) uses.set(key, []);
          uses.get(key).push({ id: chain.id, floors: cr.corridorSegments, plainWalls: cr.plainWalls,
            openings: [{ side: c.entrySide, point: cr.entryPoint }, { side: c.exitSide, point: cr.exitPoint }] });
        });
      } else {
        for (const c of chain.cells) {
          const key = `${c.rank},${c.col}`;
          if (!placer.placedByCell.has(key) || blocked.includes(key)) continue;
          const next = [...blocked, key].sort();
          const sig = next.join('|');
          if (!seen.has(sig)) { seen.add(sig); queue.push(next); }
        }
      }
    }
    out.tries += tries;
    if (!done) out.unresolvable += 1;
  }
  out.maxLoad = placer.load.size ? Math.max(...placer.load.values()) : 0;
  out.blobs = placer.stats.blobs;
  // Real wall/floor check on the placed geometry only (the model above is not trusted for this).
  for (const [key, list] of uses) {
    const [rank, col] = key.split(',').map(Number);
    const walls = [...transitCellContainmentWalls(rank, col, list.flatMap((u) => u.openings)), ...list.flatMap((u) => u.plainWalls)];
    for (const u of list) if (u.floors.some((f) => walls.some((w) => cuts(w, f)))) out.placedCutOccurrences += 1;
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) {
      if (list[a].floors.some((x) => list[b].floors.some((y) => area(x, y) > 0))) out.placedFloorCrossings += 1;
    }
  }
  return out;
}
