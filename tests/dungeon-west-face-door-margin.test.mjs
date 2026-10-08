import { describe, it, expect } from "vitest";
import * as deck from "../scripts/dungeon-deck.mjs";
import { computeRunLayout, planRunLayoutStubs } from "../scripts/dungeon-reseed.mjs";
import { cellBounds, transitCellContainmentWalls } from "../scripts/dungeon-layout.mjs";
import { buildSceneForLayout, installFoundryStubs } from "./helpers/scene-oracle.mjs";
import { sweepShapeOfRunLayout } from "./helpers/walkability-oracle.mjs";

installFoundryStubs();
const MODULE_ID = "pf2e-dungeon-crawl";

function makeFakeScene(existingWalls = []) {
  const walls = [...existingWalls];
  let nextId = walls.length;
  return {
    walls,
    async createEmbeddedDocuments(type, docs) {
      return docs.map((data) => {
        nextId += 1;
        const doc = { id: `Wall-${nextId}`, ...data, getFlag: (m, k) => data.flags?.[m]?.[k] };
        walls.push(doc);
        return doc;
      });
    },
    async deleteEmbeddedDocuments(type, ids) {
      for (const id of ids) {
        const idx = walls.findIndex((w) => w.id === id);
        if (idx >= 0) walls.splice(idx, 1);
      }
    },
  };
}

function sealedMarginWall(cellKey) {
  const flags = { [MODULE_ID]: { dungeonTransitCellMarginForCell: cellKey, dungeonTransitCellOpenings: [] } };
  return { id: "Wall-seal", c: [0, 0, 0, 0], flags, getFlag: (m, k) => flags[m]?.[k] };
}

const marginOf = (scene, key) => scene.walls.filter((w) => w.getFlag(MODULE_ID, "dungeonTransitCellMarginForCell") === key);

describe("#873 reopenBufferCellForDoor", () => {
  it("rebuilds an already-sealed buffer cell's margin with the door's own opening added", async () => {
    const { reopenBufferCellForDoor } = await import("../scripts/dungeon-scene.mjs");
    const cell = cellBounds(4, -1);
    const opening = { side: "east", point: { y: cell.gy + 3 } };
    const scene = makeFakeScene([sealedMarginWall("4,-1")]);
    await reopenBufferCellForDoor(scene, 4, -1, opening);
    const remaining = marginOf(scene, "4,-1");
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.some((w) => w.id === "Wall-seal")).toBe(false);
    expect(remaining[0].getFlag(MODULE_ID, "dungeonTransitCellOpenings")).toEqual([opening]);
    expect(remaining).toHaveLength(transitCellContainmentWalls(4, -1, [opening]).length);
  });

  it("creates a fresh margin wall with just the door's own opening when nothing sealed it yet", async () => {
    const { reopenBufferCellForDoor } = await import("../scripts/dungeon-scene.mjs");
    const cell = cellBounds(2, 1);
    const opening = { side: "east", point: { y: cell.gy + 7 } };
    const scene = makeFakeScene([]);
    await reopenBufferCellForDoor(scene, 2, 1, opening);
    const built = marginOf(scene, "2,1");
    expect(built.length).toBeGreaterThan(0);
    expect(built[0].getFlag(MODULE_ID, "dungeonTransitCellOpenings")).toEqual([opening]);
  });

  it("leaves a gap on the east side where the door sits", async () => {
    const { reopenBufferCellForDoor } = await import("../scripts/dungeon-scene.mjs");
    const cell = cellBounds(4, -1);
    const scene = makeFakeScene([sealedMarginWall("4,-1")]);
    await reopenBufferCellForDoor(scene, 4, -1, { side: "east", point: { y: cell.gy + 3 } });
    const walls = marginOf(scene, "4,-1");
    const eastX = Math.max(...walls.map((w) => w.c[0]));
    const east = walls.filter((w) => w.c[0] === eastX && w.c[2] === eastX).map((w) => [Math.min(w.c[1], w.c[3]), Math.max(w.c[1], w.c[3])]).sort((a, b) => a[0] - b[0]);
    expect(east).toHaveLength(2);
    expect(east[0][1]).toBeLessThan(east[1][0]);
  });

  it("composes with a later corridor crossing of the same buffer cell: both openings survive", async () => {
    const { reopenBufferCellForDoor } = await import("../scripts/dungeon-scene.mjs");
    const cell = cellBounds(4, -1);
    const scene = makeFakeScene([]);
    await reopenBufferCellForDoor(scene, 4, -1, { side: "east", point: { y: cell.gy + 3 } });
    const prior = marginOf(scene, "4,-1")[0].getFlag(MODULE_ID, "dungeonTransitCellOpenings");
    expect(prior).toEqual([{ side: "east", point: { y: cell.gy + 3 } }]);
    const merged = [...prior, { side: "north", point: { x: cell.gx + 1 } }];
    expect(transitCellContainmentWalls(4, -1, merged).length).toBeGreaterThan(0);
  });
});

describe("#873 a west-face reveal door is never sealed by a buffer-cell margin wall", () => {
  it.each([51, 8, 81, 163])("seed sweep-%i", async (i) => {
    const P = computeRunLayout({ generator: deck, seed: `sweep-${i}`, roomCount: 6 + (i % 15), topologyRouting: true });
    const planned = await planRunLayoutStubs(P, { retreatAvailable: true });
    const L = sweepShapeOfRunLayout(planned.layout);
    const { scene } = await buildSceneForLayout(L, 3);

    const revealDoors = scene.walls.filter((w) => w.door && (w.flags?.[MODULE_ID]?.dungeonRevealDoorForSlot || w.flags?.[MODULE_ID]?.dungeonHiddenDoorRole === "reveal"));
    const westDoors = revealDoors.filter((r) => r.c[0] === r.c[2]);
    expect(westDoors.length).toBeGreaterThan(0);
    // a buffer cell with no door/crossing landing on it stays fully sealed, unchanged
    const byCell = new Map();
    for (const w of scene.walls) {
      const k = w.flags?.[MODULE_ID]?.dungeonTransitCellMarginForCell;
      if (k) byCell.set(k, [...(byCell.get(k) ?? []), w]);
    }
    for (const [k, ws] of byCell) {
      const openings = ws[0].flags[MODULE_ID].dungeonTransitCellOpenings;
      const [r, c] = k.split(",").map(Number);
      expect(ws).toHaveLength(transitCellContainmentWalls(r, c, openings).length);
    }
    for (const rev of westDoors) {
      const [x1, y1, x2, y2] = rev.c;
      const blockers = scene.walls.filter((w) => {
        if (w === rev || w.door) return false;
        const [bx1, by1, bx2, by2] = w.c;
        if (bx1 !== bx2 || bx1 !== x1) return false;
        return Math.min(by1, by2) <= Math.min(y1, y2) && Math.max(by1, by2) >= Math.max(y1, y2);
      });
      expect(blockers).toEqual([]);
    }
  }, 30000);
});
