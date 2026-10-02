// #603: attribute every SEALED-DOOR dead edge of the shipped v3 pipeline's stub-free layout (the one the stub/wall planner
// starts from) to the wall that covers its door. Test-only measurement:
//   node tests/helpers/sealed-door-causes.mjs <chosen.json from tests/helpers/chosen-seeds.mjs> [seeds]
import fs from 'node:fs';
import * as deck from '../../scripts/dungeon-deck.mjs';
import { computeRunLayout } from '../../scripts/dungeon-reseed.mjs';
import { buildPopulateAndUnlockGraphNode } from '../../scripts/dungeon-scene.mjs';
import { findCorridorPath, outgoingDoorPlan, parentRoomIdsFor, routingForLayout } from '../../scripts/dungeon-layout.mjs';
import { installFoundryStubs, makeFakeScene } from './scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './walkability-oracle.mjs';
import { unionReports } from './stub-union.mjs';
import { roomCountOf } from './chosen-seeds.mjs';

installFoundryStubs();
const MODULE_ID = 'pf2e-dungeon-crawl';

/** buildSceneForLayout with every wall tagged `builtBy` (the room whose build created it). */
export async function buildTaggedScene(L, layoutVersion = 3) {
  const scene = makeFakeScene();
  const create = scene.createEmbeddedDocuments.bind(scene);
  let current = null;
  scene.createEmbeddedDocuments = async (type, docs) => {
    const made = await create(type, docs);
    if (type === 'Wall') for (const d of made) d.builtBy = current;
    return made;
  };
  const state = {
    seed: L.seed, layoutPositionByRoomId: L.pos, incomingFaceByRoomId: L.incFace, hiddenRooms: L.hiddenRooms,
    edges: L.edges, layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId,
    hiddenEdges: L.hiddenEdges, layoutVersion, maxRank: 20,
    ...(L.stubEdges ? { stubEdges: L.stubEdges } : {}),
    ...(L.walledEdges ? { walledEdges: L.walledEdges } : {}),
    ...(L.topologyRouting ? { topologyRouting: true } : {}),
    ...(L.extraState ?? {}),
  };
  for (const id of Object.keys(L.rooms)) {
    current = id;
    await buildPopulateAndUnlockGraphNode(scene, state, {
      id, kind: 'narrative', isGoal: false, locationTag: null, artVariant: 0, setpieceId: null,
    }, {
      rank: L.pos[id].rank, col: L.pos[id].col, childIds: L.edges[id] ?? [],
      hiddenChildId: (L.hiddenEdges[id] ?? [])[0] ?? null, unlock: false,
    });
  }
  return { layout: L, scene };
}

const overlap = (w, d) => {
  const [x1, y1, x2, y2] = d.c;
  const [a, b, c, e] = w.c;
  if (y1 === y2) return b === y1 && e === y1 && Math.max(Math.min(a, c), Math.min(x1, x2)) < Math.min(Math.max(a, c), Math.max(x1, x2));
  return a === x1 && c === x1 && Math.max(Math.min(b, e), Math.min(y1, y2)) < Math.min(Math.max(b, e), Math.max(y1, y2));
};

export const wallKind = (w) => {
  const f = w.flags?.[MODULE_ID] ?? {};
  if (f.dungeonCellMarginWallForRoom) return { kind: 'cellMargin', owner: f.dungeonCellMarginWallForRoom };
  if (f.dungeonEnclosureWallForRoom) return { kind: 'enclosure', owner: f.dungeonEnclosureWallForRoom };
  if (f.dungeonTransitCellMarginForCell) return { kind: 'transitMargin', owner: f.dungeonTransitCellMarginForCell };
  if (f.dungeonFrontierWallForEdge) return { kind: 'frontier', owner: f.dungeonFrontierWallForEdge };
  if (f.dungeonStubWallFor) return { kind: 'stubWall', owner: f.dungeonStubWallFor };
  return { kind: 'plainFlank', owner: null };
};

const incr = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

/** Sealed-door records of one base layout `P` (a `computeRunLayout` result). */
export async function sealedRecords(P) {
  const base = sweepShapeOfRunLayout(P);
  const { scene } = await buildTaggedScene(base);
  const R = unionReports(base, scene);
  const routingFor = routingForLayout({
    seed: P.seed, positionByRoomId: P.layoutPositionByRoomId, occupiedCells: P.occupiedCells, incomingFaceByRoomId: P.incomingFaceByRoomId,
    layoutEdges: P.layoutEdges, hiddenIncomingByRoomId: P.hiddenIncomingByRoomId, hiddenRooms: P.hiddenRooms, edges: P.edges, hiddenEdges: P.hiddenEdges,
  });
  const solid = scene.walls.filter((w) => !w.door);
  const doorsOf = (from, to) => ({
    out: scene.walls.find((w) => w.door && w.flags?.[MODULE_ID]?.dungeonDoorToRoomId === to && w.flags[MODULE_ID].dungeonDoorFromRoomId === from),
    rev: scene.walls.find((w) => w.door && w.flags?.[MODULE_ID]?.dungeonRevealDoorForSlot === to && w.flags[MODULE_ID].dungeonDoorFromRoomId === from),
  });
  const recs = [];
  const causeCounts = {};
  for (const e of R.W.edges.values()) {
    if (e.walkable) continue;
    incr(causeCounts, e.cause);
    if (e.cause !== 'sealedDoor') continue;
    const { from, to } = e;
    const { out, rev } = doorsOf(from, to);
    const plan = outgoingDoorPlan(base.rect[from], base.pos[from], {
      realChildIds: base.edges[from] ?? [], hiddenChildIds: (base.hiddenEdges[from] ?? []).slice(0, 1),
    }, base.pos).get(to);
    // The path the SCENE draws: the router's blocked cells / unresolvable verdict apply (the oracle's own `nullPath`
    // ignores them).
    const routing = routingFor(`${from}->${to}`);
    const unrouted = findCorridorPath(base.pos[from], base.pos[to], base.occ, {
      fromRoomId: from, toRoomId: to, incomingFace: base.incFace[to], exitFace: plan?.face,
    });
    const path = routing?.unresolvable ? null : findCorridorPath(base.pos[from], base.pos[to], base.occ, {
      fromRoomId: from, toRoomId: to, incomingFace: base.incFace[to], exitFace: plan?.face, blockedCells: routing?.blockedCells,
    });
    const routerNull = !path && !!unrouted;
    const gate = base.incFace[to] === 'west' ? { rank: base.pos[to].rank, col: base.pos[to].col - 1 } : { rank: base.pos[to].rank - 1, col: base.pos[to].col };
    const holder = base.occ[`${gate.rank},${gate.col}`];
    const parents = parentRoomIdsFor(base.layoutEdges, to);
    const realIncoming = Object.entries(base.edges).filter(([, kids]) => kids.includes(to)).map(([s]) => s);
    const revs = scene.walls.filter((w) => w.door && w.flags?.[MODULE_ID]?.dungeonRevealDoorForSlot === to);
    const horizontalRev = rev && rev.c[1] === rev.c[3];
    const key = (w) => (horizontalRev ? Math.min(w.c[0], w.c[2]) : Math.min(w.c[1], w.c[3]));
    revs.sort((a, b) => key(a) - key(b));
    const covers = [];
    for (const [role, d] of [['outgoing', out], ['reveal', rev]]) {
      if (!d) continue;
      for (const w of solid.filter((x) => overlap(x, d))) {
        const { kind, owner } = wallKind(w);
        const ownerRoom = owner && owner.includes('->') ? owner.split('->')[0] : owner;
        let rel = 'plain';
        if (owner) {
          if (ownerRoom === from) rel = 'sourceRoom';
          else if (ownerRoom === to) rel = 'targetRoom';
          else if (parents.includes(ownerRoom)) rel = 'coParent';
          else if ((base.edges[from] ?? []).includes(ownerRoom) || (base.layoutEdges[from] ?? []).includes(ownerRoom)) rel = 'sibling';
          else rel = 'foreign';
        }
        const [x1, y1, x2, y2] = d.c; const [a, b, c, f] = w.c;
        const horizontal = y1 === y2;
        const wlo = horizontal ? Math.min(a, c) : Math.min(b, f); const whi = horizontal ? Math.max(a, c) : Math.max(b, f);
        const dlo = horizontal ? Math.min(x1, x2) : Math.min(y1, y2); const dhi = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
        covers.push({ role, kind, rel, owner, builtBy: w.builtBy, full: wlo <= dlo && whi >= dhi, coords: w.c, door: d.c });
      }
    }
    recs.push({
      from, to, nullPath: !path, routerNull, pathLen: path ? path.length : 0, gateHeld: !path && !!holder && holder !== from,
      merge: realIncoming.length >= 2, parentsN: parents.length, hiddenIn: (base.hiddenIncomingByRoomId[to] ?? []).length,
      exitFace: plan?.face ?? null, incFace: base.incFace[to],
      outCovered: covers.some((c) => c.role === 'outgoing'), revCovered: covers.some((c) => c.role === 'reveal'),
      slotIdx: rev ? revs.indexOf(rev) : -1, slotN: revs.length,
      rankGap: base.pos[to].rank - base.pos[from].rank, colGap: base.pos[to].col - base.pos[from].col,
      covers,
    });
  }
  return { recs, causeCounts, realEdges: Object.values(base.edges).reduce((n, k) => n + k.length, 0), base, scene, R };
}

const bump = (tbl, name, key) => { ((tbl[name] ??= {})[key] ??= 0); tbl[name][key] += 1; };

/** The base (stub-free) layout of sweep seed `i` as the shipped pipeline chose it (`chosen[i].seed`, see chosen-seeds.mjs). */
export const baseLayoutOf = (chosen, i) => computeRunLayout({ generator: deck, seed: chosen[i].seed, roomCount: roomCountOf(i), topologyRouting: true });

/** The cause table of every sealed-door dead edge over the first `n` chosen seeds. */
export async function causeTable(chosen, n = 500) {
  const tbl = {};
  let total = 0;
  const causeCounts = {};
  for (let i = 0; i < n; i += 1) {
    const { recs, causeCounts: cc } = await sealedRecords(baseLayoutOf(chosen, i));
    for (const [k, v] of Object.entries(cc)) incr(causeCounts, k, v);
    for (const r of recs) {
      total += 1;
      bump(tbl, 'path', r.nullPath ? (r.routerNull ? 'null/routerUnresolvable' : r.gateHeld ? 'null/gateHeld' : 'null/other') : (r.pathLen > 2 ? 'found/multiCell' : 'found/adjacent'));
      if (r.gateHeld) bump(tbl, 'gateHeld shape (target - source)', `dr${Math.min(r.rankGap, 4)}${r.rankGap > 3 ? '+' : ''} dc${Math.sign(r.colGap) > 0 ? '+' : Math.sign(r.colGap) < 0 ? '-' : '0'} in-${r.incFace}`);
      bump(tbl, 'incoming', r.merge ? 'merge(2+)' : 'single');
      bump(tbl, 'doorsCovered', `${r.outCovered ? 'out' : ''}${r.outCovered && r.revCovered ? '+' : ''}${r.revCovered ? 'rev' : ''}`);
      bump(tbl, 'incFace', r.incFace);
      bump(tbl, 'exitFace', r.exitFace);
      bump(tbl, 'revSlot', r.slotN > 1 ? (r.slotIdx === 0 ? 'first' : r.slotIdx === r.slotN - 1 ? 'last' : 'middle') : 'only');
      const kinds = [...new Set(r.covers.map((c) => `${c.kind}:${c.rel}`))].sort().join('|');
      bump(tbl, 'cover(kind:relation)', kinds);
      bump(tbl, 'coverKinds', [...new Set(r.covers.map((c) => c.kind))].sort().join('+'));
      bump(tbl, 'coverFull', r.covers.every((c) => c.full) ? 'wall spans whole door' : 'partial');
      bump(tbl, 'path x covering', `${r.nullPath ? 'null' : 'found'} ${[...new Set(r.covers.map((c) => c.kind))].sort().join('+')}`);
    }
  }
  return { total, causeCounts, tbl };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { total, causeCounts, tbl } = await causeTable(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), Number(process.argv[3] ?? 500));
  console.log('sealed total', total, 'causes', causeCounts);
  for (const [k, v] of Object.entries(tbl)) console.log(k, Object.fromEntries(Object.entries(v).sort((a, b) => b[1] - a[1])));
}
