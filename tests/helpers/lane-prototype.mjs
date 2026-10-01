// tests/helpers/lane-prototype.mjs
// #427 Chunk 1 / PR B: feasibility prototype for the shared-transit-cell lane plan (no behavior).
//
// Model (mirrors buildEdgeCorridor's chain, scripts/dungeon-layout.mjs): an edge crosses cells 0..n-1;
// border j (0..n) is the one an edge enters/exits a cell by, with one scalar coordinate c[j] along it.
// c[0] (the source door's projection) and c[n] (the target door's) are pinned. A STRAIGHT cell carries
// its coordinate through (c[j+1] = c[j], as buildEdgeCorridor forces it); a CORNER cell's exit
// coordinate is the only free variable (today a seeded offset), domain = the cell's 13 offsets.
// When the last cell is straight, the run reaching it must end on the pinned door coordinate, so its
// last variable is pinned too (today a mismatch there draws a block, not a lane).
import { transitCellCrossing, cellBounds, COLUMN_STRIDE } from '../../scripts/dungeon-layout.mjs';
import { visitEdges } from './buildability.mjs';

const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };
const area = (a, b) => Math.max(0, Math.min(a.gx + a.gw, b.gx + b.gw) - Math.max(a.gx, b.gx))
  * Math.max(0, Math.min(a.gy + a.gh, b.gy + b.gh) - Math.max(a.gy, b.gy));

/** Absolute point on `side` of the cell at `coord` (x for north/south, y for east/west). */
function sidePoint(cell, side, coord) {
  if (side === 'north') return { x: coord, y: cell.gy };
  if (side === 'south') return { x: coord, y: cell.gy + cell.gh };
  if (side === 'west') return { x: cell.gx, y: coord };
  return { x: cell.gx + cell.gw, y: coord };
}
const alongStart = (cell, side) => (side === 'north' || side === 'south' ? cell.gx : cell.gy);
const coordOf = (point, side) => (side === 'north' || side === 'south' ? point.x : point.y);

/** Every edge's multi-cell chain as built today: sides, pinned end coordinates, today's coordinates. */
export function edgeChains(layout) {
  const chains = [];
  visitEdges(layout, ({ sourceId, toId, res }) => {
    const tc = res.transitCells;
    if (!tc.length) return;
    chains.push({
      id: `${sourceId}->${toId}`, sourceId, toId, seed: layout.seed, targetRank: layout.pos[toId].rank,
      cells: tc.map((c) => ({ rank: c.rank, col: c.col, entrySide: c.entrySide, exitSide: c.exitSide })),
      c0: coordOf(tc[0].entryPoint, tc[0].entrySide),
      cn: coordOf(tc.at(-1).exitPoint, tc.at(-1).exitSide),
      baseline: tc.map((c) => coordOf(c.exitPoint, c.exitSide)), // today's exit coordinate per cell
    });
  });
  return chains;
}

/** The pinned crossings exactly as buildEdgeCorridor builds them today, grouped by cell. */
export function crossingsByCell(layout) {
  const byCell = new Map();
  visitEdges(layout, ({ sourceId, toId, res }) => {
    for (const c of res.transitCells) {
      const key = `${c.rank},${c.col}`;
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push({
        edgeId: `${sourceId}->${toId}`, toId, entrySide: c.entrySide, exitSide: c.exitSide,
        entryPoint: c.entryPoint, exitPoint: c.exitPoint,
      });
    }
  });
  return byCell;
}

/** Edge order shared with the real plan: target rank, target id, source id. */
const canonical = (a, b) => a.targetRank - b.targetRank
  || (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0)
  || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/** Floors of one cell crossing for given border coordinates. */
function cellFloors(chain, i, entryCoord, exitCoord) {
  const { rank, col, entrySide, exitSide } = chain.cells[i];
  const cell = cellBounds(rank, col);
  return transitCellCrossing(chain.seed, rank, col, entrySide, exitSide, chain.id, {
    forcedEntryPoint: sidePoint(cell, entrySide, entryCoord),
    forcedExitPoint: sidePoint(cell, exitSide, exitCoord),
  }).corridorSegments;
}

/**
 * Greedy plan over `chains` in canonical order: each edge takes the first free-coordinate assignment
 * (today's value first, then nearest) whose floors intersect no already placed edge's floor in any
 * cell. An edge with no such assignment is `infeasible` (the real router would block the cell for it
 * and reroute; the prototype only counts it and leaves it unplaced).
 * Returns { infeasible: [id], maxLoad, blobs, placed: Map id -> coords[] }.
 */
export function assignLanes(chains, { nodeBudget = 50000, first = new Set() } = {}) {
  const ordered = [...chains].sort((a, b) => (first.has(b.id) - first.has(a.id)) || canonical(a, b));
  const placedByCell = new Map(); // "rank,col" -> [floors[]]
  const infeasible = [];
  const placed = new Map();
  let blobs = 0;
  let exhausted = 0;
  const load = new Map();
  for (const chain of ordered) {
    const n = chain.cells.length;
    const corner = chain.cells.map((c) => OPPOSITE[c.entrySide] !== c.exitSide);
    const vars = []; // cell indices (< n - 1) whose exit coordinate is free
    for (let i = 0; i < n - 1; i += 1) if (corner[i]) vars.push(i);
    const lastStraight = !corner[n - 1];
    // Pinned conflict with no corner at all: the existing block geometry stays as it is (counted).
    const pinnedVar = lastStraight && vars.length ? vars.at(-1) : null;
    if (lastStraight && !vars.length && chain.c0 !== chain.cn) blobs += 1;

    const domainFor = (i) => {
      if (i === pinnedVar) return [chain.cn];
      const cell = cellBounds(chain.cells[i].rank, chain.cells[i].col);
      const start = alongStart(cell, chain.cells[i].exitSide);
      const base = chain.baseline[i];
      const all = Array.from({ length: COLUMN_STRIDE }, (_, k) => start + k);
      return all.sort((a, b) => Math.abs(a - base) - Math.abs(b - base) || a - b);
    };
    const conflicts = (i, floors) => {
      const others = placedByCell.get(`${chain.cells[i].rank},${chain.cells[i].col}`) ?? [];
      return others.some((o) => o.some((f) => floors.some((g) => area(f, g) > 0)));
    };

    let nodes = 0;
    // coords[j] = coordinate on border j; filled left to right.
    const coords = new Array(n + 1).fill(null);
    coords[0] = chain.c0; coords[n] = chain.cn;
    const floorsByCell = new Array(n).fill(null);
    // Extend straight cells from border `from` up to (not including) the next free variable cell.
    const fillRun = (from, to) => {
      for (let i = from; i < to; i += 1) {
        const exitCoord = i === n - 1 ? chain.cn : coords[i + 1];
        const entryCoord = coords[i];
        floorsByCell[i] = cellFloors(chain, i, entryCoord, exitCoord);
        if (conflicts(i, floorsByCell[i])) return false;
      }
      return true;
    };
    // Straight cells i+1 .. next-1 run on coords already propagated; then recurse for the next variable.
    const solve2 = (vi, from, to) => {
      if (!fillRun(from, vi < vars.length ? vars[vi] : n)) return false;
      if (vi === vars.length) return true;
      const i = vars[vi];
      for (const v of domainFor(i)) {
        nodes += 1;
        if (nodes > nodeBudget) return false;
        coords[i + 1] = v;
        floorsByCell[i] = cellFloors(chain, i, coords[i], v);
        if (conflicts(i, floorsByCell[i])) continue;
        const next = vars[vi + 1] ?? n;
        for (let j = i + 1; j < next; j += 1) if (j < n - 1 && !corner[j]) coords[j + 1] = coords[j];
        if (solve2(vi + 1, i + 1, next)) return true;
      }
      coords[i + 1] = null;
      return false;
    };
    // First run: cells before the first variable cell run on c0.
    for (let j = 0; j < (vars[0] ?? n); j += 1) if (j < n - 1 && !corner[j]) coords[j + 1] = coords[j];
    const ok = solve2(0, 0, vars[0] ?? n);
    if (!ok) { infeasible.push(chain.id); if (nodes > nodeBudget) exhausted += 1; continue; }
    placed.set(chain.id, [...coords]);
    chain.cells.forEach((c, i) => {
      const key = `${c.rank},${c.col}`;
      if (!placedByCell.has(key)) placedByCell.set(key, []);
      placedByCell.get(key).push(floorsByCell[i]);
      load.set(key, (load.get(key) ?? 0) + 1);
    });
  }
  return { infeasible, maxLoad: Math.max(0, ...load.values()), blobs, exhausted, placed };
}

/** True if some choice of the free (corner) coordinates leaves no two chains' floors intersecting. */
export function assignableWithoutCrossing(chains) {
  return assignLanes(chains).infeasible.length === 0;
}

/** Re-runs the greedy plan with the previously blocked edges placed first, keeping the best result
 * (an upper bound on the number of edges the plan must block; the order-independent canonical plan
 * of PR C uses a fixed order and so may do slightly worse). */
export function bestAssignLanes(chains, passes = 1) {
  let best = assignLanes(chains);
  let first = new Set(best.infeasible);
  for (let p = 0; p < passes && best.infeasible.length; p += 1) {
    const next = assignLanes(chains, { first });
    if (next.infeasible.length < best.infeasible.length) best = next;
    first = new Set([...first, ...next.infeasible]);
  }
  return best;
}
