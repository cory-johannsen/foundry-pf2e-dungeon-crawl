// tests/helpers/passage-oracle.mjs
// #427 Task 2.2: the acceptance check for the pure lane planner. The planner is NOT wired into the scene yet
// (Task 2.4), so the walls a scene would build around a lane are modelled on top of the REAL walls the v3
// scene builder produces for everything else:
//   1. take the scene's solid walls (doors are kept apart),
//   2. drop each served edge's own fallback plain walls (the lane replaces that fallback line),
//   3. add the lane's flank walls (`passageLaneGeometry`),
//   4. carve the one-unit opening where the lane crosses a cell border out of the scene's margin and
//      transit-cell containment walls (what `openingsByCell` asks the wall builders to leave).
// Then a flood fill (`buildFloorModel`) over rooms and every corridor floor, with doors counted as SOLID, must
// reach exactly the lane's own tiles from its first mouth tile (connected end to end, nothing else reachable:
// no other corridor, no room, no other mouth), and neither of the lane's doors may be covered by a wall.
import { buildFloorModel } from './floor-oracle.mjs';
import { buildSweepScene } from './scene-oracle.mjs';
import { measurePlan } from './passage-layout.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const GRID = 100;
const norm = (w) => ({ x1: Math.min(w.x1, w.x2), y1: Math.min(w.y1, w.y2), x2: Math.max(w.x1, w.x2), y2: Math.max(w.y1, w.y2) });
const same = (a, b) => a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
const tileKey = (t) => `${t.x},${t.y}`;
const overlapsOnLine = (w, d) => (d.y1 === d.y2
  ? w.y1 === w.y2 && w.y1 === d.y1 && Math.max(w.x1, d.x1) < Math.min(w.x2, d.x2)
  : w.x1 === w.x2 && w.x1 === d.x1 && Math.max(w.y1, d.y1) < Math.min(w.y2, d.y2));
const CARVABLE = ['dungeonCellMarginWallForRoom', 'dungeonTransitCellMarginForCell'];

/** Removes the unit edge `u` from every carvable wall that covers it (splitting the wall around it). */
function carve(walls, u) {
  const out = [];
  for (const w of walls) {
    if (!w.carvable || !overlapsOnLine(w, u)) { out.push(w); continue; }
    if (w.y1 === w.y2) {
      if (w.x1 < u.x1) out.push({ ...w, x2: u.x1 });
      if (u.x2 < w.x2) out.push({ ...w, x1: u.x2 });
    } else {
      if (w.y1 < u.y1) out.push({ ...w, y2: u.y1 });
      if (u.y2 < w.y2) out.push({ ...w, y1: u.y2 });
    }
  }
  return out;
}

/** Counts door walls covered, even partly, by a collinear solid wall. */
function sealedCount(solid, doors) {
  return doors.filter((d) => solid.some((w) => overlapsOnLine(w, d))).length;
}

/**
 * Runs the oracle on one v3 sweep seed. Returns counts of failures per kind (all must be 0) plus how many
 * lanes were served and how many doors were sealed before and after the lanes replace their fallback lines.
 */
export async function oracleForSeed(i) {
  const { layout, scene } = await buildSweepScene(i, 3);
  const { m, edges, lanes } = measurePlan(layout);
  const solid0 = scene.walls.filter((w) => !w.door).map((w) => ({
    ...norm({ x1: w.c[0] / GRID, y1: w.c[1] / GRID, x2: w.c[2] / GRID, y2: w.c[3] / GRID }),
    carvable: CARVABLE.some((f) => w.getFlag(MODULE_ID, f) !== undefined),
  }));
  const doors = scene.walls.filter((w) => w.door).map((w) => norm({ x1: w.c[0] / GRID, y1: w.c[1] / GRID, x2: w.c[2] / GRID, y2: w.c[3] / GRID }));

  let solid = solid0.slice();
  for (const e of edges) {
    if (!lanes.has(e.edgeId)) continue;
    for (const pw of e.res.plainWalls) {
      const n = norm(pw);
      const at = solid.findIndex((w) => same(w, n));
      if (at >= 0) solid.splice(at, 1);
    }
  }
  const fails = { notConnected: 0, leaks: 0, doorSealed: 0 };
  for (const [edgeId, lane] of lanes) {
    // a door on a cell border (a north/west-face door always is) is a crossing too: carve its unit
    const e = edges.find((x) => x.edgeId === edgeId);
    solid = carve(solid, norm(e.res.doorWall));
    solid = carve(solid, norm(e.res.revealDoorWall));
    for (const w of lane.walls) solid.push({ ...norm(w), carvable: false, lane: true });
    const { tiles } = lane;
    for (let k = 1; k < tiles.length; k += 1) {
      const a = tiles[k - 1]; const b = tiles[k];
      // the unit edge between two consecutive tiles in different cells is where a border opening is asked for
      const u = a.x !== b.x
        ? { x1: Math.max(a.x, b.x), y1: a.y, x2: Math.max(a.x, b.x), y2: a.y + 1 }
        : { x1: a.x, y1: Math.max(a.y, b.y), x2: a.x + 1, y2: Math.max(a.y, b.y) };
      solid = carve(solid, u);
    }
  }
  const floors = [
    ...Object.values(layout.rect),
    ...edges.filter((e) => !lanes.has(e.edgeId)).flatMap((e) => e.floors),
    ...[...lanes.values()].flatMap((l) => l.floors),
  ];
  const model = buildFloorModel(floors, [...solid, ...doors]);
  for (const [edgeId, lane] of lanes) {
    const want = new Set(lane.tiles.map(tileKey));
    const got = model.reach(tileKey(lane.tiles[0]));
    if (process.env.ORACLE_DEBUG && !got.has(tileKey(lane.tiles.at(-1)))) {
      const k = lane.tiles.findIndex((p) => !got.has(tileKey(p)));
      const a = lane.tiles[k - 1]; const b = lane.tiles[k];
      const u = a.x !== b.x ? { x1: Math.max(a.x, b.x), y1: a.y, x2: Math.max(a.x, b.x), y2: a.y + 1 } : { x1: a.x, y1: Math.max(a.y, b.y), x2: a.x + 1, y2: Math.max(a.y, b.y) };
      const blockers = solid.filter((w) => overlapsOnLine(w, u));
      console.log('blocked', edgeId, JSON.stringify({ a, b, u, blockers, doorsHere: doors.filter((w) => overlapsOnLine(w, u)) }));
    }
    if (!got.has(tileKey(lane.tiles.at(-1)))) fails.notConnected += 1;
    if ([...got].some((t) => !want.has(t))) fails.leaks += 1;
    const e = edges.find((x) => x.edgeId === edgeId);
    const doorsOfLane = [norm(e.res.doorWall), norm(e.res.revealDoorWall)];
    if (doorsOfLane.some((d) => solid.some((w) => overlapsOnLine(w, d)))) fails.doorSealed += 1;
  }
  return {
    served: lanes.size, targets: m.targets, fails,
    sealedBefore: sealedCount(solid0, doors), sealedAfter: sealedCount(solid, doors),
  };
}
