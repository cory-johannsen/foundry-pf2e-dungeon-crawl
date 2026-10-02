// #603: the branching an ideal fix of the sealed doors could buy. On each chosen seed's stub-free base layout, count the rooms
// with 2+ live forward exits (reachable from room-entry, goal excluded) when the dead set is:
//   status quo (all union-dead edges), sealed doors fixed (sealedDoor edges live again), null-path fixed, nothing dead.
//   node tests/helpers/upper-bound.mjs <chosen.json> [seeds]
import fs from 'node:fs';
import { sealedRecords, baseLayoutOf } from './sealed-door-causes.mjs';

function metrics(edges, dead) {
  const seen = new Set(['room-entry']);
  const q = ['room-entry'];
  while (q.length) { const x = q.shift(); for (const c of edges[x] ?? []) if (!seen.has(c) && !dead.has(`${x}->${c}`)) { seen.add(c); q.push(c); } }
  let branching = 0; let exits = 0; let deadEnds = 0;
  for (const id of seen) {
    if (id === 'room-goal') continue;
    const n = (edges[id] ?? []).filter((c) => !dead.has(`${id}->${c}`)).length;
    exits += n; if (n >= 2) branching += 1; if (n === 0) deadEnds += 1;
  }
  return { branching, exits, reached: seen.size, deadEnds };
}

/** Per scenario (see the file header): `{ branching, exits, reached, dead, deadEnds }` summed over the first `n` chosen seeds. */
export async function upperBound(chosen, n = 500) {
  const tot = {};
  const add = (k, m) => { const t = (tot[k] ??= { branching: 0, exits: 0, reached: 0, dead: 0, deadEnds: 0 }); t.branching += m.branching; t.exits += m.exits; t.reached += m.reached; t.deadEnds += m.deadEnds; t.dead += m.dead ?? 0; };
  for (let i = 0; i < n; i += 1) {
    const { base, R, recs } = await sealedRecords(baseLayoutOf(chosen, i));
    const dead = R.union.dead;
    const sealed = new Set(recs.map((r) => `${r.from}->${r.to}`));
    const nullKeys = new Set(recs.filter((r) => r.nullPath).map((r) => `${r.from}->${r.to}`));
    const sub = (a, b) => new Set([...a].filter((x) => !b.has(x)));
    add('status quo (all union-dead edges dropped)', { ...metrics(base.edges, dead), dead: dead.size });
    add('sealed-door edges live again', { ...metrics(base.edges, sub(dead, sealed)), dead: sub(dead, sealed).size });
    add('null-path sealed edges live again', { ...metrics(base.edges, sub(dead, nullKeys)), dead: sub(dead, nullKeys).size });
    add('nothing dead (graph upper bound)', { ...metrics(base.edges, new Set()), dead: 0 });
  }
  return tot;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tot = await upperBound(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), Number(process.argv[3] ?? 500));
  for (const [k, v] of Object.entries(tot)) console.log(k.padEnd(46), JSON.stringify(v));
}
