import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCreatureArtPack } from "../tools/check-creature-art-pack.mjs";

const ART = "modules/pf2e-dungeon-crawl/assets/creature-art/";
let root, artPath, sourceDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf2edc-pack-check-"));
  artPath = join(root, "creature-art.json");
  sourceDir = join(root, "_source");
  mkdirSync(sourceDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (id, art) => ({ id, pack: "pf2e.p", docId: id, name: id, level: 0, art });
const writeArt = (entries) => writeFileSync(artPath, JSON.stringify(entries));
const writeDoc = (fileId, entryId, art) =>
  writeFileSync(
    join(sourceDir, `${fileId}.json`),
    JSON.stringify({
      _id: fileId,
      img: `${ART}${art}`,
      flags: { "pf2e-dungeon-crawl": { artEntryId: entryId } },
    }),
  );
const check = () => checkCreatureArtPack({ creatureArtPath: artPath, sourceDir });

describe("checkCreatureArtPack", () => {
  it("reports a fresh pack as 0 missing / 0 stale", () => {
    writeArt([entry("a", "a.webp"), entry("b", "b.webp")]);
    writeDoc("n1", "a", "a.webp");
    writeDoc("n2", "b", "b.webp");
    const r = check();
    expect(r).toMatchObject({ missing: 0, stale: 0, total: 2, packDocs: 2, fresh: true });
  });

  it("counts an art entry absent from the pack as missing", () => {
    writeArt([entry("a", "a.webp"), entry("b", "b.webp")]);
    writeDoc("n1", "a", "a.webp");
    const r = check();
    expect(r.missing).toBe(1);
    expect(r.stale).toBe(0);
    expect(r.fresh).toBe(false);
    expect(r.examples.join("\n")).toContain("b");
  });

  it("counts a doc whose art path changed as stale", () => {
    writeArt([entry("a", "a-v2.webp")]);
    writeDoc("n1", "a", "a.webp");
    const r = check();
    expect(r).toMatchObject({ missing: 0, stale: 1, fresh: false });
  });

  it("counts a doc whose entry was removed as stale", () => {
    writeArt([entry("a", "a.webp")]);
    writeDoc("n1", "a", "a.webp");
    writeDoc("n2", "gone", "gone.webp");
    const r = check();
    expect(r).toMatchObject({ missing: 0, stale: 1, fresh: false });
  });

  it("limits examples to 10 and exposes strict exit semantics", () => {
    writeArt(Array.from({ length: 25 }, (_, i) => entry(`e${i}`, `${i}.webp`)));
    const r = check();
    expect(r.missing).toBe(25);
    expect(r.examples.length).toBeLessThanOrEqual(10);
    expect(r.exitCode(false)).toBe(0);
    expect(r.exitCode(true)).toBe(1);
  });

  it("strict exits 0 when fresh", () => {
    writeArt([entry("a", "a.webp")]);
    writeDoc("n1", "a", "a.webp");
    expect(check().exitCode(true)).toBe(0);
  });
});
