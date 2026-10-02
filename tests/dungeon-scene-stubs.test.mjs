// #427 Chunk 6, PR G3: the scene builds dead-end stubs. Every check below reads the REAL walls and tiles a built
// v3 scene holds (fake Foundry scene), never the pure geometry's claims.
import { describe, it, expect, beforeAll } from 'vitest';
import { buildSceneForLayout, sealedDoors, installFoundryStubs } from './helpers/scene-oracle.mjs';
import { buildFloorModel } from './helpers/floor-oracle.mjs';
import { buildStubbedSweepLayout } from './helpers/stub-sweep.mjs';
import { buildSweepLayout } from './helpers/layout-sweep.mjs';
import { unlockDoorsFromRoom } from '../scripts/dungeon-scene.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';
const flagsOf = (w) => w.flags?.[MODULE_ID] ?? {};
const RUBBLE = `modules/${MODULE_ID}/assets/dungeon-rooms/corridor-rubble.webp`;

const stubCount = (L) => Object.values(L.stubEdges).flat().length;
// Default (shipped) mode: only hidden shortcuts are eligible. Retreat mode is Chunk 7's population, used here so
// real (non-hidden) stubs are built and checked too.
const pick = (retreatAvailable, want) => {
  const out = [];
  for (let i = 0; i < 500 && out.length < want; i += 1) {
    const L = buildStubbedSweepLayout(i, { retreatAvailable });
    if (stubCount(L)) out.push(L);
  }
  return out;
};

function corridorCells(scene) {
  // Every non-room tile is a one-cell corridor tile (connection, transit cell or stub): x/y are cell centers.
  return scene.tiles.filter((t) => !flagsOf(t).dungeonRoomBuilt)
    .map((t) => ({ gx: Math.round(t.x / 100 - 0.5), gy: Math.round(t.y / 100 - 0.5), gw: 1, gh: 1 }));
}
const solidWalls = (scene) => scene.walls.filter((w) => !w.door).map((w) => ({ x1: w.c[0] / 100, y1: w.c[1] / 100, x2: w.c[2] / 100, y2: w.c[3] / 100 }));

// Does the open segment p-q properly cross the axis-aligned wall w? (touching an end does not count)
function crosses(p, q, w) {
  if (p.x === q.x) {
    return w.y1 === w.y2 && w.y1 > Math.min(p.y, q.y) && w.y1 < Math.max(p.y, q.y)
      && p.x >= Math.min(w.x1, w.x2) && p.x <= Math.max(w.x1, w.x2);
  }
  return w.x1 === w.x2 && w.x1 > Math.min(p.x, q.x) && w.x1 < Math.max(p.x, q.x)
    && p.y >= Math.min(w.y1, w.y2) && p.y <= Math.max(w.y1, w.y2);
}

describe.each([
  ['default (hidden shortcut stubs)', false, 500],
  ['retreat available (real stubs too)', true, 500],
])('built stubs, %s', (_name, retreat, want) => {
  const built = [];
  beforeAll(async () => {
    for (const L of pick(retreat, want)) built.push({ L, ...(await buildSceneForLayout(L, 3)) });
  }, 300000);

  it('builds one locked door per stub with the stub flags, never a progression or reveal door', () => {
    let n = 0;
    for (const { L, scene } of built) {
      for (const [src, ts] of Object.entries(L.stubEdges)) {
        for (const tgt of ts) {
          const g = L.stubGeometries.get(`${src}->${tgt}`);
          const doors = scene.walls.filter((w) => w.door && flagsOf(w).dungeonStubDoorFor === tgt && flagsOf(w).dungeonDoorFromRoomId === src);
          expect(doors, `${L.seed} ${src}->${tgt}`).toHaveLength(1);
          const [d] = doors;
          expect(d.ds).toBe(2); // LOCKED, like a normal door
          expect(d.c.map((v) => v / 100)).toEqual([g.doorWall.x1, g.doorWall.y1, g.doorWall.x2, g.doorWall.y2]);
          expect(flagsOf(d).dungeonStubFlavor).toBe('rubble');
          expect(flagsOf(d).dungeonDoorToRoomId).toBeUndefined();
          expect(flagsOf(d).dungeonRevealDoorForSlot).toBeUndefined();
          const hidden = (L.hiddenEdges[src] ?? []).includes(tgt);
          expect(flagsOf(d).dungeonHiddenDoorForEdge).toBe(hidden ? `${src}->${tgt}` : undefined);
          if (hidden) expect(flagsOf(d).dungeonHiddenDoorRole).toBe('gate');
          n += 1;
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('builds the flank, the end caps and the floor: length tiles, rubble on the cap', () => {
    for (const { L, scene } of built) {
      for (const [src, ts] of Object.entries(L.stubEdges)) {
        for (const tgt of ts) {
          const key = `${src}->${tgt}`;
          const g = L.stubGeometries.get(key);
          const walls = scene.walls.filter((w) => flagsOf(w).dungeonStubWallFor === key);
          expect(walls.map((w) => w.c.map((v) => v / 100)).sort()).toEqual(g.walls.map((w) => [w.x1, w.y1, w.x2, w.y2]).sort());
          const tiles = scene.tiles.filter((t) => flagsOf(t).dungeonStubCorridorFor === key);
          expect(tiles).toHaveLength(g.length);
          const caps = tiles.filter((t) => t.texture.src === RUBBLE);
          expect(caps).toHaveLength(1);
          // the cap is the far end, away from the door
          const f = g.floor[0];
          const capCell = Math.round(caps[0].x / 100 - 0.5);
          expect(capCell).toBe(g.dir > 0 ? f.gx + f.gw - 1 : f.gx);
        }
      }
    }
  });

  it('the stub door is openable (not covered by a solid wall) and the floor is walkable end to end', () => {
    for (const { L, scene } of built) {
      const sealed = sealedDoors(scene).sealedDoorWalls;
      const walls = solidWalls(scene);
      for (const [src, ts] of Object.entries(L.stubEdges)) {
        for (const tgt of ts) {
          const g = L.stubGeometries.get(`${src}->${tgt}`);
          const doorKey = g.doorWall;
          expect(sealed.some((s) => flagsOf({ flags: { [MODULE_ID]: s.flags } }).dungeonStubDoorFor === tgt && s.flags.dungeonDoorFromRoomId === src), `${L.seed} ${src}->${tgt} sealed`).toBe(false);
          // center line: out of the door, down to the row center, along the floor to the cap tile center
          const f = g.floor[0];
          const door = { x: doorKey.x1 + 0.5, y: doorKey.y1 };
          const row = { x: door.x, y: doorKey.y1 + 0.5 };
          const far = { x: g.dir > 0 ? f.gx + f.gw - 0.5 : f.gx + 0.5, y: row.y };
          for (const [p, q] of [[door, row], [row, far]]) {
            for (const w of walls) expect(crosses(p, q, w), `${L.seed} ${src}->${tgt} line crosses wall ${JSON.stringify(w)}`).toBe(false);
          }
        }
      }
    }
  });

  it('floor oracle on the real scene: from the door tile the stub reaches exactly its own tiles', () => {
    for (const { L, scene } of built) {
      const model = buildFloorModel(corridorCells(scene), solidWalls(scene));
      for (const [src, ts] of Object.entries(L.stubEdges)) {
        for (const tgt of ts) {
          const g = L.stubGeometries.get(`${src}->${tgt}`);
          const f = g.floor[0];
          const own = Array.from({ length: f.gw }, (_v, k) => `${f.gx + k},${f.gy}`).sort();
          expect([...model.reach(`${g.doorSpan.x1},${f.gy}`)].sort(), `${L.seed} ${src}->${tgt}`).toEqual(own);
        }
      }
    }
  });

  it('unlockDoorsFromRoom unlocks a real stub door and leaves a hidden one sealed', async () => {
    globalThis.foundry = { audio: { AudioHelper: { play: () => {} } } };
    for (const { L, scene } of built) {
      for (const [src, ts] of Object.entries(L.stubEdges)) {
        await unlockDoorsFromRoom(scene, src, L.edges[src] ?? [], L.hiddenEdges[src] ?? []);
        for (const tgt of ts) {
          const d = scene.walls.find((w) => w.door && flagsOf(w).dungeonStubDoorFor === tgt && flagsOf(w).dungeonDoorFromRoomId === src);
          const hidden = (L.hiddenEdges[src] ?? []).includes(tgt);
          expect(d.ds, `${L.seed} ${src}->${tgt}`).toBe(hidden ? 2 : 0);
        }
      }
    }
  });
});

describe('what the scene does NOT do with stubs', () => {
  it('a state without stubEdges (or with an empty map) builds exactly the same scene', async () => {
    const L = buildSweepLayout(3, { layoutVersion: 3 });
    const a = await buildSceneForLayout(L, 3);
    const b = await buildSceneForLayout({ ...L, stubEdges: {} }, 3);
    const strip = (s) => JSON.stringify([s.walls.map((w) => [w.c, w.door, w.ds, w.flags]), s.tiles.map((t) => [t.x, t.y, t.rotation, t.texture.src])]);
    expect(strip(b.scene)).toBe(strip(a.scene));
  });

  it('a layoutVersion 2 state ignores stubEdges: no stub door, wall or tile', async () => {
    installFoundryStubs();
    const L = buildStubbedSweepLayout(0, { retreatAvailable: true });
    expect(stubCount(L)).toBeGreaterThan(0);
    const v2Layout = { ...buildSweepLayout(0, { layoutVersion: 2 }), stubEdges: L.stubEdges };
    const { scene } = await buildSceneForLayout(v2Layout, 2);
    expect(scene.walls.some((w) => flagsOf(w).dungeonStubDoorFor || flagsOf(w).dungeonStubWallFor)).toBe(false);
    expect(scene.tiles.some((t) => flagsOf(t).dungeonStubCorridorFor)).toBe(false);
  });
});
