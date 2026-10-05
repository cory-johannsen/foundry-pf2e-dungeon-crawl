import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PACK_DIR = join(ROOT, "packs", "generated-creature-art");
const SOURCE_DIR = join(PACK_DIR, "_source");

describe("shipped generated-creature-art pack", () => {
  it("is declared exactly once in module.json", () => {
    const mod = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));
    expect(mod.packs).toHaveLength(1);
    expect(mod.packs[0]).toMatchObject({
      name: "generated-creature-art",
      path: "packs/generated-creature-art",
      type: "Actor",
      system: "pf2e",
    });
  });

  it("contains a compiled LevelDB and a non-empty _source", () => {
    expect(existsSync(join(PACK_DIR, "CURRENT"))).toBe(true);
    expect(readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".json")).length).toBeGreaterThan(0);
  });

  it("has _source docs whose _id matches the filename and whose art entry exists", () => {
    const art = JSON.parse(readFileSync(join(ROOT, "data", "creature-art.json"), "utf8"));
    const ids = new Set(art.map((e) => e.id));
    const bad = [];
    for (const f of readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".json"))) {
      const doc = JSON.parse(readFileSync(join(SOURCE_DIR, f), "utf8"));
      const entryId = doc.flags?.["pf2e-dungeon-crawl"]?.artEntryId;
      if (doc._id !== f.replace(/\.json$/, "") || !ids.has(entryId)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});
