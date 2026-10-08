// #823: corridor pieces are chosen from OPENINGS, so a joint where the corridor continues never has a wall drawn
// across it and no two corridor tiles stack on one cell. Judged over 100 routed v3 seeds (the live default:
// computeRunLayout({topologyRouting:true}) -> planRunLayoutStubs -> buildSceneForLayout), through the REAL scene
// builder (buildSceneForLayout drives buildPopulateAndUnlockGraphNode), grouping tiles by their
// `dungeonCorridorEdge` flag. Numbers are exact and deterministic; if the generator changes they move, re-measure.
//
// Invariants, per corridor (= one edge id), with a piece's openings read from PIECE_OPENINGS:
//   I0  no cell holds two corridor tiles (scene-wide, stubs included)
//   I1  for side-adjacent cells A,B of one corridor: A open toward B iff B open toward A
//   I2  for side-adjacent cells A,B of one corridor: BOTH are open toward each other. Symmetry (I1) alone is not
//       enough: two closed caps facing each other is symmetric, and that was the live bug (a wall drawn across an
//       open corridor). Cells with 3+ same-corridor neighbours (fallback `mid`) are excluded and counted.
import { describe, it, expect } from 'vitest';
import * as deck from '../scripts/dungeon-deck.mjs';
import { computeRunLayout, planRunLayoutStubs } from '../scripts/dungeon-reseed.mjs';
import { layoutEdgeGeometry, outgoingPlanForStubs, mergeEdgeMaps } from '../scripts/dungeon-layout.mjs';
import { corridorTilesForSegments, routingFromState } from '../scripts/dungeon-scene.mjs';
import { PIECE_OPENINGS, hasBlock2x2 } from '../scripts/corridor-pieces.mjs';
import { buildSceneForLayout, installFoundryStubs } from './helpers/scene-oracle.mjs';
import { sweepShapeOfRunLayout } from './helpers/walkability-oracle.mjs';

installFoundryStubs();
const MODULE_ID = 'pf2e-dungeon-crawl';
const SEEDS = 100;
const DELTA = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };

const cellOf = (t) => [Math.round((t.x - 50) / 100), Math.round((t.y - 50) / 100)];
const keyOf = (gx, gy) => `${gx},${gy}`;
/** Openings of a corridor tile from its art file + rotation (the table in corridor-pieces.mjs). */
function openingsOfTile(t) {
  const file = t.texture.src.split('/').pop().replace('.webp', '');
  const variant = file === 'corridor' ? 'single' : file.replace('corridor-', '');
  const rot = t.rotation ?? 0;
  const key = variant === 'single' ? 'single' : `${variant}@${variant === 'mid' ? rot % 180 : rot}`;
  const open = PIECE_OPENINGS[key];
  if (!open) throw new Error(`no opening entry for ${key}`);
  return new Set(open);
}

/** I1/I2 + door-end checks over groups: Map<groupId, Map<cellKey, Set<openings>[]>> (several tiles per cell = a stack). */
function judge(groups, { allTilesCount }) {
  const r = { pairs: 0, i1: 0, i2: 0, excludedCells: 0, wideGroups: 0, doorEnds: 0, doorEndBad: 0, crossEdgeCells: 0, examples: [] };
  for (const [gid, cells] of groups) {
    const keys = new Set(cells.keys());
    if (hasBlock2x2(keys)) { r.wideGroups += 1; continue; }
    const neighbours = (k) => {
      const [gx, gy] = k.split(',').map(Number);
      return Object.entries(DELTA).filter(([, [dx, dy]]) => keys.has(keyOf(gx + dx, gy + dy))).map(([s]) => s);
    };
    const excluded = new Set([...keys].filter((k) => neighbours(k).length >= 3));
    r.excludedCells += excluded.size;
    for (const [k, stack] of cells) {
      const [gx, gy] = k.split(',').map(Number);
      const nb = neighbours(k);
      // A cell that opens toward a cell its corridor LOST to an earlier corridor (the documented cross-edge
      // overlap: first wins, the later corridor's tile on that cell is dropped) has an opening with no
      // same-corridor neighbour behind it. Counted separately (and ratcheted), not judged as a door end.
      if (!excluded.has(k) && [...stack.at(-1)].some((s) => !nb.includes(s))) { r.crossEdgeCells += 1; continue; }
      if (!excluded.has(k) && nb.length === 1) {
        r.doorEnds += 1;
        if (!(stack.at(-1).size === 1 && stack.at(-1).has(nb[0]))) { r.doorEndBad += 1; r.examples.push(`${gid} end ${k}`); }
      }
      for (const side of nb) {
        const [dx, dy] = DELTA[side];
        const nk = keyOf(gx + dx, gy + dy);
        if (excluded.has(k) || excluded.has(nk)) continue;
        if (k > nk) continue; // each pair once
        r.pairs += 1;
        // A stack (only the old rule has them) shows its last-created tile.
        const aOpen = stack.at(-1).has(side);
        const bOpen = cells.get(nk).at(-1).has(OPP[side]);
        if (aOpen !== bOpen) r.i1 += 1;
        if (!(aOpen && bOpen)) { r.i2 += 1; if (r.examples.length < 5) r.examples.push(`${gid} ${k}->${nk}`); }
      }
    }
  }
  return r;
}

describe('#823 corridor joins (100 routed v3 seeds, through the real scene builder)', () => {
  it('new rule: no stacked tiles, no wall across a joint (I0/I1/I2); the old per-segment rule fails I2 on the same layouts', async () => {
    const t = {
      seeds: 0, corridorTiles: 0, stackedCells: 0, newPairs: 0, newI1: 0, newI2: 0, newExcluded: 0, newWide: 0, newDoorEnds: 0, newDoorEndBad: 0, newCrossEdgeCells: 0,
      oldTiles: 0, oldStackedCells: 0, oldPairs: 0, oldI1: 0, oldI2: 0, corners: 0, stackExamples: [], badExamples: [],
    };
    for (let i = 0; i < SEEDS; i += 1) {
      const P = computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15), topologyRouting: true });
      const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
      const L = sweepShapeOfRunLayout(planned.layout);
      const { scene } = await buildSceneForLayout(L, 3);
      t.seeds += 1;

      // ---- I0: scene-wide, every 1x1 tile (corridor tiles and #427 stubs) ----
      const perCell = new Map();
      for (const tile of scene.tiles.filter((x) => x.width === 100 && x.height === 100)) {
        const k = keyOf(...cellOf(tile));
        perCell.set(k, (perCell.get(k) ?? 0) + 1);
      }
      for (const [k, n] of perCell) if (n > 1) { t.stackedCells += 1; if (t.stackExamples.length < 5) t.stackExamples.push(`sweep-${i} ${k} x${n}`); }

      // ---- new rule, from the scene's own tiles grouped by the dungeonCorridorEdge flag ----
      const groups = new Map();
      for (const tile of scene.tiles) {
        const edge = tile.flags?.[MODULE_ID]?.dungeonCorridorEdge;
        if (!edge) continue;
        t.corridorTiles += 1;
        if (tile.texture.src.endsWith('corridor-corner.webp')) t.corners += 1;
        if (!groups.has(edge)) groups.set(edge, new Map());
        const cells = groups.get(edge);
        const k = keyOf(...cellOf(tile));
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(openingsOfTile(tile));
      }
      const nj = judge(groups, {});
      t.newPairs += nj.pairs; t.newI1 += nj.i1; t.newI2 += nj.i2; t.newExcluded += nj.excludedCells; t.newWide += nj.wideGroups;
      t.newCrossEdgeCells += nj.crossEdgeCells; t.newDoorEnds += nj.doorEnds; t.newDoorEndBad += nj.doorEndBad;
      if (nj.i2 || nj.doorEndBad) t.badExamples.push(`sweep-${i}: ${nj.examples.join('; ')}`);

      // ---- OLD rule on the same layout inputs: the unchanged per-segment helper (corridorTileVariant caps) ----
      const state = {
        seed: L.seed, layoutPositionByRoomId: L.pos, incomingFaceByRoomId: L.incFace, hiddenRooms: L.hiddenRooms,
        edges: L.edges, layoutEdges: L.layoutEdges, hiddenIncomingByRoomId: L.hiddenIncomingByRoomId,
        hiddenEdges: L.hiddenEdges, layoutVersion: 3, stubEdges: L.stubEdges ?? {}, walledEdges: L.walledEdges ?? {},
        topologyRouting: !!L.topologyRouting,
      };
      const occupiedCells = {};
      for (const [id, p] of Object.entries(L.pos)) occupiedCells[`${p.rank},${p.col}`] = id;
      const planFor = (src) => outgoingPlanForStubs(L.seed, src, {
        edges: state.edges, hiddenEdges: state.hiddenEdges, stubEdges: state.stubEdges, positionByRoomId: L.pos,
      });
      const geo = layoutEdgeGeometry({
        seed: L.seed, positionByRoomId: L.pos, occupiedCells, layoutEdges: L.layoutEdges, hiddenRooms: L.hiddenRooms,
        hiddenIncomingByRoomId: L.hiddenIncomingByRoomId, incomingFaceByRoomId: L.incFace, planFor,
        stubEdges: mergeEdgeMaps(state.stubEdges, state.walledEdges), routingFor: routingFromState(state),
      });
      const oldGroups = new Map();
      const oldPerCell = new Map();
      for (const g of geo) {
        const edgeId = `${g.sourceId}->${g.toId}`;
        const oldTiles = [
          ...corridorTilesForSegments(g.result.corridorSegments, { fullWidth: true }).tiles,
          ...g.result.transitCells.flatMap((tc) => corridorTilesForSegments(tc.corridorSegments).tiles),
        ];
        const cells = new Map();
        for (const tile of oldTiles) {
          t.oldTiles += 1;
          const k = keyOf(...cellOf(tile));
          oldPerCell.set(k, (oldPerCell.get(k) ?? 0) + 1);
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(openingsOfTile(tile));
        }
        oldGroups.set(edgeId, cells);
      }
      for (const n of oldPerCell.values()) if (n > 1) t.oldStackedCells += 1;
      const oj = judge(oldGroups, {});
      t.oldPairs += oj.pairs; t.oldI1 += oj.i1; t.oldI2 += oj.i2;
    }

    // The check is known to detect the live bug: on the same layouts the old per-segment end-cap rule (reimplemented
    // here by running the unchanged corridorTilesForSegments over each edge's segments) draws a wall across
    // 1735 open joints (I2), is asymmetric on 518 (I1) and stacks 1230 cells (I0) (#860: west-face corridor geometry moved these from 1874/530/1257;
    // #906: unreachable detours are no longer produced, 1749/530/1247 -> 1735/518/1230).
    expect([t.oldI2, t.oldI1, t.oldStackedCells]).toEqual([1735, 518, 1230]);
    // The new rule: no stacked cell scene-wide (stubs included), no wall across a joint, symmetric, every door end
    // an end cap open toward its one neighbour. Before -> after: stacked cells 1257 -> 0.
    expect(t.stackExamples).toEqual([]);
    expect(t.badExamples).toEqual([]);
    expect([t.stackedCells, t.newI1, t.newI2, t.newDoorEndBad]).toEqual([0, 0, 0, 0]);
    // Coverage: pairs judged, door ends judged, cells excluded for 3+ same-corridor neighbours, wide (#555) corridors
    // (none in routed v3), bend cells now drawn with the corner piece, and the documented cross-edge overlap (sweep-51:
    // a hidden detour crosses another corridor; first wins, 2 cells open toward a cell the other corridor owns).
    expect([t.newPairs, t.newDoorEnds, t.newExcluded, t.newWide, t.corners, t.newCrossEdgeCells])
      .toEqual([19535, 2468, 0, 0, 1246, 0]);
    // #906: the sweep-51 cross-edge overlap (2 cells) was that seed's unreachable detour's fallback line; it is gone.
    // Pairs 20095 -> 19535, door ends 2480 -> 2468, corners 1259 -> 1246 (56 fewer detour rooms over 500 seeds; here 12 over 100).
    // #860: pairs 20196 -> 20095 (incl. the cell in front of each north-approached west door), corners 1269 -> 1259 (west-face detour corner and final leg moved one cell west, off the room).
    // One tile per distinct cell: 22901 old tiles (incl. stacked duplicates) -> 21519 flagged corridor tiles (#860: west-face detour legs moved off the destination room's first column; was 22877 -> 21620).
    // #906: 22901 -> 22313 old tiles, 21519 -> 20948 corridor tiles (the dropped detours' corridors and fallback lines).
    expect([t.oldTiles, t.corridorTiles]).toEqual([22313, 20948]);
  }, 600000);
});
