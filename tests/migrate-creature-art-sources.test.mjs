import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// #628: fixture-driven tests for the re-runnable normalizer.
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../tools/migrate-creature-art-sources.mjs");

let tmp;
const A = "pf2e.pack-a";
const B = "pf2e.pack-b";
const entry = (id, pack, art, docId = id) => ({ id, pack, docId, name: id, level: 1, art });

function write(rel, content) {
  const p = resolve(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
const git = (...args) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
const art = (rel) => resolve(tmp, "assets/creature-art", rel);
const data = () => JSON.parse(readFileSync(resolve(tmp, "data/creature-art.json"), "utf8"));
const listing = () => readdirSync(resolve(tmp, "assets/creature-art"), { recursive: true }).filter((f) => f.endsWith(".webp")).sort();
const run = () => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ART_MIGRATE_ROOT: tmp }, encoding: "utf8" });

function setup(entries, files, genLines = []) {
  for (const f of files) write(`assets/creature-art/${f}`, `bytes-${f}`);
  write("data/creature-art.json", `${JSON.stringify(entries, null, 2)}\n`);
  write("tools/generate-token-art.mjs", `${genLines.join("\n")}\n`);
  git("add", "-A");
}

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "migrate-art-"));
  git("init", "-q");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const baseEntries = () => [
  entry("goblin_lob", A, "goblin-lob.webp"),
  entry("guard", A, "guard.webp"),
  entry("guard_lob", B, "guard.webp"),
];
const baseFiles = ["goblin-lob.webp", "guard.webp"];
const baseGen = [
  "  { id: 'goblin-lob', file: 'goblin-lob', dir: 'assets/creature-art', prompt: 'x' },",
  "  { id: 'guard', file: 'guard', dir: 'assets/creature-art', prompt: 'x' },",
];

describe("migrate-creature-art-sources", () => {
  it("(a) moves files into <source>/ and shared/, prefixes ids, strips _lob, keeps shared ids unique", () => {
    setup(baseEntries(), baseFiles, baseGen);
    const r = run();
    expect(r.status).toBe(0);
    expect(listing()).toEqual(["pack-a/goblin-lob.webp", "shared/guard.webp"]);
    const d = data();
    expect(d.map((e) => [e.id, e.art])).toEqual([
      ["pack_a__goblin", "pack-a/goblin-lob.webp"],
      ["shared__pack_a__guard", "shared/guard.webp"],
      ["shared__pack_b__guard", "shared/guard.webp"],
    ]);
    const gen = readFileSync(resolve(tmp, "tools/generate-token-art.mjs"), "utf8");
    expect(gen).toContain("file: 'goblin-lob', dir: 'assets/creature-art/pack-a'");
    expect(gen).toContain("file: 'guard', dir: 'assets/creature-art/shared'");
  });

  it("(b) an immediate second run changes nothing", () => {
    setup(baseEntries(), baseFiles, baseGen);
    expect(run().status).toBe(0);
    git("add", "-A");
    const before = [readFileSync(resolve(tmp, "data/creature-art.json"), "utf8"), git("status", "--porcelain"), listing()];
    expect(run().status).toBe(0);
    git("add", "-A");
    const after = [readFileSync(resolve(tmp, "data/creature-art.json"), "utf8"), git("status", "--porcelain"), listing()];
    expect(after).toEqual(before);
  });

  it("(c) a new flat entry for a pack that already has a folder is moved into it", () => {
    setup(baseEntries(), baseFiles, baseGen);
    expect(run().status).toBe(0);
    write("assets/creature-art/orc-lob.webp", "orc");
    write("data/creature-art.json", `${JSON.stringify([...data(), entry("orc_lob", A, "orc-lob.webp")], null, 2)}\n`);
    git("add", "-A");
    expect(run().status).toBe(0);
    expect(existsSync(art("orc-lob.webp"))).toBe(false);
    expect(existsSync(art("pack-a/orc-lob.webp"))).toBe(true);
    expect(data().find((e) => e.docId === "orc_lob").id).toBe("pack_a__orc");
  });

  it("(d) a new flat entry from pack B reusing art nested at pack-a/ promotes it to shared/ without double prefixes", () => {
    setup([entry("x", A, "x.webp")], ["x.webp"]);
    expect(run().status).toBe(0);
    expect(existsSync(art("pack-a/x.webp"))).toBe(true);
    write("data/creature-art.json", `${JSON.stringify([...data(), entry("x_lob", B, "x.webp", "x2")], null, 2)}\n`);
    git("add", "-A");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(listing()).toEqual(["shared/x.webp"]);
    expect(data().map((e) => [e.id, e.art])).toEqual([
      ["shared__pack_a__x", "shared/x.webp"],
      ["shared__pack_b__x", "shared/x.webp"],
    ]);
  });

  it("(e) a flat stray duplicate next to a nested original aborts, lists both, moves nothing", () => {
    setup([entry("x", A, "x.webp")], ["x.webp"]);
    expect(run().status).toBe(0);
    write("assets/creature-art/x.webp", "stray");
    git("add", "-A");
    const beforeJson = readFileSync(resolve(tmp, "data/creature-art.json"), "utf8");
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("pack-a/x.webp");
    expect(listing()).toEqual(["pack-a/x.webp", "x.webp"]);
    expect(readFileSync(resolve(tmp, "data/creature-art.json"), "utf8")).toBe(beforeJson);
  });

  it("(f) a referenced file that exists nowhere aborts and moves nothing", () => {
    setup(baseEntries(), baseFiles, baseGen);
    git("rm", "-q", "-f", "assets/creature-art/guard.webp");
    const r = run();
    expect(r.status).not.toBe(0);
    expect(listing()).toEqual(["goblin-lob.webp"]);
    expect(data()[0].id).toBe("goblin_lob");
  });
});
