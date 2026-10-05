import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

// #628: the per-source layout is enforced in CI, not just by the validator
// script, so art added by out-of-repo tooling can't land flat.
const root = resolve(import.meta.dirname, "..");
const ART_DIR = resolve(root, "assets/creature-art");
const entries = JSON.parse(readFileSync(resolve(root, "data/creature-art.json"), "utf8"));
const HINT = "run `npm run art:normalize`";

describe("creature-art layout (#628)", () => {
  it(`every entry's art is <source>/<file>.webp (${HINT})`, () => {
    const bad = entries.filter((e) => !/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\.webp$/.test(e.art));
    expect(bad.map((e) => `${e.id}: ${e.art}`)).toEqual([]);
  });

  it(`ids are unique, so shared-file entries from different packs never collide (${HINT})`, () => {
    const seen = new Map();
    for (const e of entries) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([]);
  });

  it(`every id is prefixed by its folder (dashes to underscores; shared/ also by the entry's own pack source) and has no _lob suffix (${HINT})`, () => {
    const bad = entries.filter((e) => {
      const folder = e.art.split("/")[0];
      const packSource = e.pack.replace(/^pf2e\./, "").replace(/-/g, "_");
      const prefix = folder === "shared" ? `shared__${packSource}__` : `${folder.replace(/-/g, "_")}__`;
      return !e.id.startsWith(prefix) || e.id.endsWith("_lob");
    });
    expect(bad.map((e) => `${e.id}: ${e.art}`)).toEqual([]);
  });

  it(`a file used by more than one pack lives in shared/, and only such files do (${HINT})`, () => {
    const packsByArt = new Map();
    for (const e of entries) {
      if (!packsByArt.has(e.art)) packsByArt.set(e.art, new Set());
      packsByArt.get(e.art).add(e.pack);
    }
    const bad = [];
    for (const [art, packs] of packsByArt) {
      const inShared = art.startsWith("shared/");
      if (packs.size > 1 && !inShared) bad.push(`${art} used by ${packs.size} packs but not in shared/`);
      if (packs.size === 1 && inShared) bad.push(`${art} is in shared/ but used by one pack`);
    }
    expect(bad).toEqual([]);
  });

  it(`no .webp sits directly in assets/creature-art/ (${HINT})`, () => {
    const flat = readdirSync(ART_DIR).filter((f) => f.endsWith(".webp") && statSync(resolve(ART_DIR, f)).isFile());
    expect(flat).toEqual([]);
  });

  it(`every .webp under assets/creature-art/ is referenced by an entry, so no orphan survives a move (${HINT})`, () => {
    const referenced = new Set(entries.map((e) => e.art));
    const orphans = readdirSync(ART_DIR, { recursive: true })
      .map((f) => f.split("\\").join("/"))
      .filter((f) => f.endsWith(".webp") && !referenced.has(f));
    expect(orphans).toEqual([]);
  });
});
