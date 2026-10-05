import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync,
  readdirSync, statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";
import { buildCreatureArtPack } from "../tools/build-creature-art-pack.mjs";

const ART = "modules/pf2e-dungeon-crawl/assets/creature-art/";
let root;
let declared; // system.json packs[] for the fixture system

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf2edc-pack-build-"));
  declared = [];
  mkdirSync(join(root, "sys", "packs"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeSystemJson() {
  writeFileSync(join(root, "sys", "system.json"), JSON.stringify({ packs: declared }));
}

function actor(id, name, extra = {}) {
  return {
    _id: id,
    _key: `!actors!${id}`,
    name,
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    folder: "oldfolderid00000",
    prototypeToken: { texture: { src: "icons/svg/mystery-man.svg", scaleX: 2 } },
    items: [],
    effects: [],
    ...extra,
  };
}
function item(actorId, id, name) {
  return { _id: id, _key: `!actors.items!${actorId}.${id}`, name, type: "melee" };
}

/** Compiles a real LevelDB fixture pack at sys/packs/<dir>/ and declares
 * it in system.json as `name -> packs/<dir>`. */
async function fixturePack(name, dir, docs, { declare = true } = {}) {
  const srcDir = join(root, "fixture-src", dir);
  mkdirSync(srcDir, { recursive: true });
  for (const d of docs) writeFileSync(join(srcDir, `${d._id}.json`), JSON.stringify(d));
  await compilePack(srcDir, join(root, "sys", "packs", dir), { log: false });
  if (declare) declared.push({ name, path: `packs/${dir}` });
  writeSystemJson();
}

function entry(pack, docId, name, art, id) {
  return { id: id ?? `${pack}__${name}`, pack: `pf2e.${pack}`, docId, name, level: 0, art };
}

function run(entries, overrides = {}) {
  const creatureArtPath = join(root, "creature-art.json");
  writeFileSync(creatureArtPath, JSON.stringify(entries));
  const paths = {
    creatureArtPath,
    systemPacksDir: join(root, "sys", "packs"),
    scratchDir: join(root, "scratch"),
    sourceOutDir: join(root, "out", "_source"),
    packOutDir: join(root, "out", "pack"),
    log: false,
    ...overrides,
  };
  return buildCreatureArtPack(paths).then(() => paths);
}

const readOut = (dir, f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const newIdOf = (pack, docId) =>
  createHash("sha1").update(`pf2e.${pack}:${docId}`).digest("base64")
    .replace(/[^A-Za-z0-9]/g, "").slice(0, 16);

function hashTree(dir) {
  const h = createHash("sha1");
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      statSync(p).isDirectory() ? walk(p) : out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe("buildCreatureArtPack", () => {
  it("builds across two packs: overrides art, derives ids/keys, sets flags, compiles a readable LevelDB", async () => {
    await fixturePack("fixture-one", "fixture-one", [
      actor("aaaaaaaaaaaaaaaa", "Goblin", {
        items: [item("aaaaaaaaaaaaaaaa", "iiiiiiiiiiiiiii1", "Jaws")],
        effects: [{ _id: "eeeeeeeeeeeeeee1", _key: "!actors.effects!aaaaaaaaaaaaaaaa.eeeeeeeeeeeeeee1", name: "Fx" }],
        flags: { other: { keep: true } },
      }),
    ]);
    await fixturePack("fixture-two", "fixture-two", [actor("bbbbbbbbbbbbbbbb", "Skeleton")]);

    const paths = await run([
      entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "one/goblin.webp", "art_goblin"),
      entry("fixture-two", "bbbbbbbbbbbbbbbb", "Skeleton", "two/skeleton.webp", "art_skel"),
    ]);

    const gid = newIdOf("fixture-one", "aaaaaaaaaaaaaaaa");
    expect(gid).toHaveLength(16);
    const g = readOut(paths.sourceOutDir, `${gid}.json`);
    expect(g._id).toBe(gid);
    expect(g._key).toBe(`!actors!${gid}`);
    expect(g.items[0]._key).toBe(`!actors.items!${gid}.iiiiiiiiiiiiiii1`);
    expect(g.effects[0]._key).toBe(`!actors.effects!${gid}.eeeeeeeeeeeeeee1`);
    expect(g.folder).toBeNull();
    expect(g.img).toBe(`${ART}one/goblin.webp`);
    expect(g.prototypeToken.texture.src).toBe(`${ART}one/goblin.webp`);
    expect(g.prototypeToken.texture.scaleX).toBe(2); // only src replaced
    expect(g.flags.other).toEqual({ keep: true });
    expect(g.flags["pf2e-dungeon-crawl"]).toEqual({
      artEntryId: "art_goblin",
      sourcePack: "pf2e.fixture-one",
      sourceDocId: "aaaaaaaaaaaaaaaa",
    });

    expect(existsSync(join(paths.packOutDir, "CURRENT"))).toBe(true);
    const back = join(root, "readback");
    await extractPack(paths.packOutDir, back, { log: false });
    const docs = readdirSync(back).filter((f) => f.endsWith(".json"));
    expect(docs).toHaveLength(2);
    const names = docs.map((f) => readOut(back, f).name).sort();
    expect(names).toEqual(["Goblin", "Skeleton"]);
  });

  it("resolves a pack whose name differs from its directory via system.json", async () => {
    await fixturePack("fixture-name", "fixture-dir", [actor("cccccccccccccccc", "Odd")]);
    const paths = await run([entry("fixture-name", "cccccccccccccccc", "Odd", "x/odd.webp")]);
    expect(readdirSync(paths.sourceOutDir)).toEqual([`${newIdOf("fixture-name", "cccccccccccccccc")}.json`]);
  });

  it("throws naming the pack for missing system.json, undeclared pack, and declared-but-missing dir", async () => {
    // no system.json yet
    await expect(run([entry("ghost-pack", "dddddddddddddddd", "G", "x.webp")])).rejects.toThrow(/system\.json/);

    declared = [{ name: "other", path: "packs/other" }];
    writeSystemJson();
    await expect(run([entry("ghost-pack", "dddddddddddddddd", "G", "x.webp")])).rejects.toThrow(/"pf2e\.ghost-pack" is not declared/);

    declared = [{ name: "ghost-pack", path: "packs/nowhere" }];
    writeSystemJson();
    await expect(run([entry("ghost-pack", "dddddddddddddddd", "G", "x.webp")])).rejects.toThrow(/"pf2e\.ghost-pack" declares directory .*does not exist/);
  });

  it("throws naming the docId when it is absent from the pack", async () => {
    await fixturePack("fixture-one", "fixture-one", [actor("aaaaaaaaaaaaaaaa", "Goblin")]);
    await expect(
      run([entry("fixture-one", "zzzzzzzzzzzzzzzz", "Nope", "x.webp")]),
    ).rejects.toThrow(/zzzzzzzzzzzzzzzz/);
  });

  it("keeps two entries from different packs that share one docId as distinct docs", async () => {
    await fixturePack("pack-a", "pack-a", [actor("sameidsameidsame", "Monster")]);
    await fixturePack("pack-b", "pack-b", [actor("sameidsameidsame", "Monster Copy")]);
    const paths = await run([
      entry("pack-a", "sameidsameidsame", "Monster", "a/m.webp", "e_a"),
      entry("pack-b", "sameidsameidsame", "Monster Copy", "b/m.webp", "e_b"),
    ]);
    const files = readdirSync(paths.sourceOutDir);
    expect(files).toHaveLength(2);
    const idA = newIdOf("pack-a", "sameidsameidsame");
    const idB = newIdOf("pack-b", "sameidsameidsame");
    expect(idA).not.toBe(idB);
    expect(readOut(paths.sourceOutDir, `${idA}.json`).img).toBe(`${ART}a/m.webp`);
    expect(readOut(paths.sourceOutDir, `${idB}.json`).img).toBe(`${ART}b/m.webp`);
    const back = join(root, "readback");
    await extractPack(paths.packOutDir, back, { log: false });
    expect(readdirSync(back).filter((f) => f.endsWith(".json"))).toHaveLength(2);
  });

  it("de-duplicates embedded items listing the same _id twice, keeping the first", async () => {
    // compilePack rejects duplicate ids, so write the raw LevelDB directly.
    const { ClassicLevel } = await import("classic-level");
    const dir = join(root, "sys", "packs", "dupe");
    mkdirSync(dir, { recursive: true });
    const db = new ClassicLevel(dir, { keyEncoding: "utf8", valueEncoding: "json" });
    // As in real pf2e packs: the actor stores an id list for its embedded
    // items (here with a repeated id) and each item is its own record.
    const a = actor("dddddddddddddd01", "Shobhad", {
      items: ["iiiiiiiiiiiiiii1", "iiiiiiiiiiiiiii1", "iiiiiiiiiiiiiii2"],
    });
    await db.put(a._key, a);
    await db.put("!actors.items!dddddddddddddd01.iiiiiiiiiiiiiii1", item("dddddddddddddd01", "iiiiiiiiiiiiiii1", "First"));
    await db.put("!actors.items!dddddddddddddd01.iiiiiiiiiiiiiii2", item("dddddddddddddd01", "iiiiiiiiiiiiiii2", "Other"));
    await db.close();
    declared.push({ name: "dupe", path: "packs/dupe" });
    writeSystemJson();

    const logs = [];
    const orig = console.log;
    console.log = (...x) => logs.push(x.join(" "));
    let paths;
    try {
      paths = await run([entry("dupe", "dddddddddddddd01", "Shobhad", "x.webp")], { log: true });
    } finally {
      console.log = orig;
    }
    const out = readOut(paths.sourceOutDir, `${newIdOf("dupe", "dddddddddddddd01")}.json`);
    expect(out.items.map((i) => i.name)).toEqual(["First", "Other"]);
    expect(logs.join("\n")).toMatch(/\b1 duplicate/i);
  });

  it("leaves the system directory byte-for-byte untouched and copies no LOCK file", async () => {
    await fixturePack("fixture-one", "fixture-one", [actor("aaaaaaaaaaaaaaaa", "Goblin")]);
    // Plant a marker in the system's LOCK: LevelDB recreates an (empty) LOCK
    // when it opens the copy, so only a copied LOCK would carry the marker.
    writeFileSync(join(root, "sys", "packs", "fixture-one", "LOCK"), "MARKER-FROM-SYSTEM");
    const before = hashTree(join(root, "sys"));
    const filesBefore = listFiles(join(root, "sys")).sort();
    expect(filesBefore.some((f) => f.endsWith("/LOCK"))).toBe(true); // fixture really has one
    const paths = await run([entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "x.webp")]);
    expect(hashTree(join(root, "sys"))).toBe(before);
    expect(listFiles(join(root, "sys")).sort()).toEqual(filesBefore);
    const scratchFiles = listFiles(paths.scratchDir);
    for (const f of scratchFiles.filter((f) => /(^|\/)LOCK$/.test(f))) {
      expect(readFileSync(f, "utf8")).not.toContain("MARKER-FROM-SYSTEM");
    }
  });

  it("clears stale scratch before extraction", async () => {
    await fixturePack("fixture-one", "fixture-one", [actor("aaaaaaaaaaaaaaaa", "Goblin")]);
    const staleExtract = join(root, "scratch", "extract", "fixture-one");
    mkdirSync(staleExtract, { recursive: true });
    writeFileSync(join(staleExtract, "leftover.json"), JSON.stringify(actor("leftoverleftover", "Leftover")));
    const staleCopy = join(root, "scratch", "copies", "fixture-one");
    mkdirSync(staleCopy, { recursive: true });
    writeFileSync(join(staleCopy, "junk.ldb"), "junk");
    const paths = await run([entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "x.webp")]);
    expect(existsSync(join(staleExtract, "leftover.json"))).toBe(false);
    expect(existsSync(join(staleCopy, "junk.ldb"))).toBe(false);
    const files = readdirSync(paths.sourceOutDir);
    expect(files).toEqual([`${newIdOf("fixture-one", "aaaaaaaaaaaaaaaa")}.json`]);
    const back = join(root, "readback");
    await extractPack(paths.packOutDir, back, { log: false });
    expect(readdirSync(back).map((f) => readOut(back, f).name)).toEqual(["Goblin"]);
  });

  it("is idempotent: two runs yield identical _source content", async () => {
    await fixturePack("fixture-one", "fixture-one", [actor("aaaaaaaaaaaaaaaa", "Goblin")]);
    await fixturePack("fixture-two", "fixture-two", [actor("bbbbbbbbbbbbbbbb", "Skeleton")]);
    const entries = [
      entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "a.webp"),
      entry("fixture-two", "bbbbbbbbbbbbbbbb", "Skeleton", "b.webp"),
    ];
    const p1 = await run(entries);
    const h1 = hashTree(p1.sourceOutDir);
    const p2 = await run(entries);
    expect(hashTree(p2.sourceOutDir)).toBe(h1);
  });

  it("throws on a derived-id collision (identical pack and docId)", async () => {
    await fixturePack("fixture-one", "fixture-one", [actor("aaaaaaaaaaaaaaaa", "Goblin")]);
    await expect(
      run([
        entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "a.webp", "e1"),
        entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "b.webp", "e2"),
      ]),
    ).rejects.toThrow(/Derived id collision/);
  });

  it("removes a stale _source doc from a previous build and compiles only fresh docs", async () => {
    await fixturePack("fixture-one", "fixture-one", [actor("aaaaaaaaaaaaaaaa", "Goblin")]);
    const sourceOutDir = join(root, "out", "_source");
    mkdirSync(sourceOutDir, { recursive: true });
    writeFileSync(
      join(sourceOutDir, "staleid000000000.json"),
      JSON.stringify(actor("staleid000000000", "Stale")),
    );
    const paths = await run([entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "x.webp")]);
    expect(existsSync(join(paths.sourceOutDir, "staleid000000000.json"))).toBe(false);
    const back = join(root, "readback");
    await extractPack(paths.packOutDir, back, { log: false });
    expect(readdirSync(back).map((f) => readOut(back, f).name)).toEqual(["Goblin"]);
  });

  it("keeps _source inside packOutDir even when sourceOutDir is not normalized", async () => {
    await fixturePack("fixture-one", "fixture-one", [actor("aaaaaaaaaaaaaaaa", "Goblin")]);
    const packOutDir = join(root, "shipped", "pack");
    mkdirSync(packOutDir, { recursive: true });
    writeFileSync(join(packOutDir, "old.ldb"), "old");
    for (const sourceOutDir of [
      join(packOutDir, "_source") + "/",
      join(packOutDir, "x", "..", "_source"),
      join(packOutDir, ".", "_source"),
    ]) {
      await run([entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "x.webp")], {
        packOutDir,
        sourceOutDir,
      });
      expect(readdirSync(join(packOutDir, "_source"))).toHaveLength(1);
      expect(existsSync(join(packOutDir, "CURRENT"))).toBe(true);
      expect(existsSync(join(packOutDir, "old.ldb"))).toBe(false);
    }
  });

  it("refuses a packOutDir that is the system packs dir or its parent, deleting nothing", async () => {
    await fixturePack("fixture-one", "fixture-one", [actor("aaaaaaaaaaaaaaaa", "Goblin")]);
    const before = hashTree(join(root, "sys"));
    for (const packOutDir of [join(root, "sys", "packs"), join(root, "sys")]) {
      await expect(
        run([entry("fixture-one", "aaaaaaaaaaaaaaaa", "Goblin", "x.webp")], {
          packOutDir,
          sourceOutDir: join(root, "out", "_source"),
        }),
      ).rejects.toThrow(/Refusing/);
    }
    expect(hashTree(join(root, "sys"))).toBe(before);
  });
});
