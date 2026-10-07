// #852: marching order moved to its own window (MarchingOrderApp); the
// Dungeon Tracker must keep no trace of it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("Dungeon Tracker has no marching order", () => {
  it("template has no marching-order markup or actions", () => {
    const tpl = read("templates/dungeon-tracker.hbs");
    expect(tpl).not.toMatch(/marching/i);
  });

  it("DungeonApp has no marching-order context, actions, handlers or imports", () => {
    const src = read("scripts/ui/dungeon-app.mjs");
    expect(src).not.toMatch(/marching/i);
    expect(src).not.toContain("setMarchingOrder");
  });

  it("the tracker-only locale key is gone; the window's keys exist", () => {
    const lang = JSON.parse(read("lang/en.json"));
    expect(lang["PF2EDC.Dungeon.MarchingOrder.Title"]).toBeUndefined();
    expect(lang["PF2EDC.MarchingOrder.Title"]).toBe("Marching Order");
  });
});
