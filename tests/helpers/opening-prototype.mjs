// #603 PROTOTYPE (test helper): "cut an opening in the covering wall". For every sealed-door dead edge of a base
// layout, split each solid wall that covers its door into the pieces outside the door's span (a gap EXACTLY the door
// span) and re-ask the walkability oracle. Reports how many dead edges become walkable and what the rest die of.
//   node tests/helpers/opening-prototype.mjs <chosen.json> [seeds]
import fs from 'node:fs';
import { edgeWalkability } from './walkability-oracle.mjs';
import { sealedRecords, wallKind, baseLayoutOf } from './sealed-door-causes.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const CELL = 100;

/** A copy of `scene` whose walls covering `doors` are split around the door spans. */
export function sceneWithOpenings(scene, doors) {
  let walls = scene.walls.slice();
  for (const d of doors) {
    const next = [];
    const [x1, y1, x2, y2] = d.c;
    const horizontal = y1 === y2;
    const dlo = horizontal ? Math.min(x1, x2) : Math.min(y1, y2);
    const dhi = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
    for (const w of walls) {
      const [a, b, c, e] = w.c;
      const collinear = !w.door && (horizontal ? b === y1 && e === y1 : a === x1 && c === x1);
      const wlo = horizontal ? Math.min(a, c) : Math.min(b, e);
      const whi = horizontal ? Math.max(a, c) : Math.max(b, e);
      if (!collinear || !(Math.max(wlo, dlo) < Math.min(whi, dhi))) { next.push(w); continue; }
      const mk = (lo, hi) => ({ ...w, c: horizontal ? [lo, y1, hi, y1] : [x1, lo, x1, hi], cutFrom: w.cutFrom ?? w });
      if (wlo < dlo) next.push(mk(wlo, dlo));
      if (whi > dhi) next.push(mk(dhi, whi));
    }
    walls = next;
  }
  return { ...scene, walls };
}

/** The corridor-side cell `"x,y"` of a door wall (same rule as the walkability oracle). */
export function outsideCellOf(d, outward) {
  const [x1, y1, x2] = d.c.map((n) => n / CELL);
  const horizontal = d.c[1] === d.c[3];
  const cx = Math.floor(Math.min(x1, x2) + 1e-9);
  const cy = Math.floor(y1 + 1e-9);
  if (horizontal) return outward === 'out' ? `${cx},${cy}` : `${cx},${cy - 1}`;
  return outward === 'out' ? `${cx},${cy}` : `${cx - 1},${cy}`;
}

/**
 * The walls that cut a dead edge's corridor: Dijkstra over the tile floor from `s` to `t`, a wall unit-edge costing 1,
 * returning the walls crossed on the cheapest route (`null` when an end has no floor or `t` is unreachable even
 * ignoring walls).
 */
export function cuttingWalls(model, s, t) {
  if (!model.floor.has(s) || !model.floor.has(t)) return null;
  const dist = new Map([[s, 0]]);
  const prev = new Map();
  const open = [s];
  const done = new Set();
  while (open.length) {
    open.sort((a, b) => dist.get(b) - dist.get(a));
    const cur = open.pop();
    if (done.has(cur)) continue;
    done.add(cur);
    if (cur === t) break;
    const [x, y] = cur.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${y + dy}`;
      if (!model.floor.has(k)) continue;
      const hit = model.blockedBy(model.solid, x, y, x + dx, y + dy) ?? model.blockedBy(model.doors, x, y, x + dx, y + dy);
      const nd = dist.get(cur) + (hit ? 1 : 0);
      if (!dist.has(k) || nd < dist.get(k)) { dist.set(k, nd); prev.set(k, { from: cur, hit }); open.push(k); }
    }
  }
  if (!dist.has(t)) return null;
  const walls = [];
  for (let c = t; c !== s; c = prev.get(c).from) if (prev.get(c).hit) walls.push(...prev.get(c).hit);
  return [...new Set(walls)];
}

/** Cut an exact-span opening in every wall covering a sealed door and re-run the walkability oracle: a tally by path class. */
export async function openingExperiment(chosen, n = 500) {
  const tally = {};
  const bump = (k, v = 1) => { tally[k] = (tally[k] ?? 0) + v; };
  for (let i = 0; i < n; i += 1) {
    const { recs, base, scene } = await sealedRecords(baseLayoutOf(chosen, i));
    if (!recs.length) continue;
    const find = (from, to) => ({
      out: scene.walls.find((w) => w.door && w.flags?.[MODULE_ID]?.dungeonDoorToRoomId === to && w.flags[MODULE_ID].dungeonDoorFromRoomId === from),
      rev: scene.walls.find((w) => w.door && w.flags?.[MODULE_ID]?.dungeonRevealDoorForSlot === to && w.flags[MODULE_ID].dungeonDoorFromRoomId === from),
    });
    const doors = recs.flatMap((r) => { const d = find(r.from, r.to); return [d.out, d.rev]; }).filter(Boolean);
    const cut = sceneWithOpenings(scene, doors);
    const W = edgeWalkability(base, cut);
    for (const r of recs) {
      const e = W.edges.get(`${r.from}->${r.to}`);
      const cls = r.nullPath ? (r.gateHeld ? 'null/gateHeld' : 'null/other') : 'found';
      bump(`${cls} total`);
      bump(`${cls} -> ${e.walkable ? 'WALKABLE' : e.cause}`);
      if (e.cause === 'wallCut') {
        const d = find(r.from, r.to);
        const ws = cuttingWalls(W.model, outsideCellOf(d.out, 'out'), outsideCellOf(d.rev, 'rev')) ?? [];
        bump(`${cls} cut by ${Math.min(ws.length, 4)}${ws.length > 3 ? '+' : ''} wall(s)`);
        for (const k of new Set(ws.map((w) => (w.door ? 'door' : wallKind(w.cutFrom ?? w).kind)))) bump(`${cls} cutKind ${k}`);
      }
    }
  }
  return tally;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await openingExperiment(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), Number(process.argv[3] ?? 500)));
}
