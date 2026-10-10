#!/usr/bin/env node
// Audit tool for the creature -> environment map (#1272).
// Usage: node tools/audit-creature-environments.mjs [--probe] [--merge] [--out out/]
// PF2E_SYSTEM_PACKS_DIR follows the packs:build convention (see README); pack
// dirs are copied (minus LOCK) into os.tmpdir() before extraction, never opened
// in place. Writes only to out/ and, with --merge, data/.
// Probe result (habitat prose): see tools/creature-environment-patterns.mjs.
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, cpSync, existsSync, mkdtempSync,
} from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractPack } from "@foundryvtt/foundryvtt-cli";
import { readPackDirectories } from "./build-creature-art-pack.mjs";
import { candidateFor, mergeCandidates, matchArtToDocs, extractHabitatText } from "./creature-environment-patterns.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Copy (minus LOCK) and extract every pack referenced by creature-art.json
 * into a scratch dir under os.tmpdir(). Yields { pack, docs[] } per pack. */
export async function* readSourcePacks(systemPacksDir, packNames, scratchDir) {
  const dirOf = readPackDirectories(systemPacksDir);
  for (const pack of packNames) {
    const packName = pack.replace(/^pf2e\./, "");
    const relDir = dirOf.get(packName);
    if (!relDir) throw new Error(`Pack "${pack}" is not declared in system.json`);
    const srcDir = join(systemPacksDir, "..", relDir);
    if (!existsSync(srcDir)) throw new Error(`Pack "${pack}" directory ${srcDir} does not exist`);
    const copyDir = join(scratchDir, "copies", packName);
    const extractDir = join(scratchDir, "extract", packName);
    mkdirSync(extractDir, { recursive: true });
    cpSync(srcDir, copyDir, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
    await extractPack(copyDir, extractDir, { log: false });
    const docs = [];
    for (const file of readdirSync(extractDir)) {
      if (!file.endsWith(".json")) continue;
      docs.push(JSON.parse(readFileSync(join(extractDir, file), "utf8")));
    }
    // Free this pack's scratch right away so disk use stays at one pack.
    rmSync(copyDir, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
    yield { pack, docs };
  }
}

function parseArgs(argv) {
  const a = { probe: false, merge: false, out: join(ROOT, "out") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--probe") a.probe = true;
    else if (argv[i] === "--merge") a.merge = true;
    else if (argv[i] === "--out") a.out = resolve(argv[++i]);
  }
  return a;
}

async function probe(systemPacksDir, packNames, scratch) {
  const re = /habitat|found in|lives in|dwells/i;
  const fields = new Map(); // field -> { hits, samples:[] }
  let docsSeen = 0;
  const perPack = [];
  for await (const { pack, docs } of readSourcePacks(systemPacksDir, packNames, scratch)) {
    const npcs = docs.filter((d) => d.type === "npc").slice(0, 200);
    let hit = 0;
    for (const d of npcs) {
      docsSeen++;
      let any = false;
      for (const [k, v] of Object.entries(d.system?.details ?? {})) {
        const text = typeof v === "string" ? v : v && typeof v === "object" ? Object.values(v).filter((x) => typeof x === "string").join(" ") : "";
        const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        const m = plain.match(new RegExp(`[^.]*(?:${re.source})[^.]*\\.?`, "i"));
        if (!m) continue;
        any = true;
        const f = fields.get(`system.details.${k}`) ?? { hits: 0, samples: [] };
        f.hits++;
        if (f.samples.length < 5) f.samples.push(`${d.name}: ${m[0].trim().slice(0, 200)}`);
        fields.set(`system.details.${k}`, f);
      }
      if (any) hit++;
    }
    perPack.push(`${pack}: ${hit}/${npcs.length} docs with habitat-like sentence`);
  }
  console.log(`Probed ${docsSeen} npc docs`);
  perPack.forEach((l) => console.log(l));
  for (const [field, { hits, samples }] of fields) {
    console.log(`\n${field}: ${hits} hits`);
    samples.forEach((s) => console.log(`  - ${s}`));
  }
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const sample = (arr, n) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};

async function audit(args, art, packNames, systemPacksDir, scratch) {
  const byPack = new Map();
  for (const e of art) byPack.set(e.pack, [...(byPack.get(e.pack) ?? []), e]);
  const candidates = {};
  const rows = []; // { id, name, pack, basis, environments }
  const review = []; // rows plus level/traits/notes, for hand review (out/ only)
  let missingTotal = 0;
  for await (const { pack, docs } of readSourcePacks(systemPacksDir, packNames, scratch)) {
    const docsById = new Map(docs.map((d) => [d._id, d]));
    const { matched, missing } = matchArtToDocs(byPack.get(pack) ?? [], docsById);
    if (missing.length) {
      missingTotal += missing.length;
      console.warn(`${pack}: ${missing.length} art entr${missing.length === 1 ? "y has" : "ies have"} no extracted doc (e.g. ${missing.slice(0, 3).map((e) => e.id).join(", ")})`);
    }
    for (const { entry: e, doc } of matched) {
      const c = candidateFor(doc);
      candidates[e.id] = c.environments;
      rows.push({ id: e.id, name: e.name, pack, ...c });
      review.push({
        id: e.id, name: e.name, pack, level: e.level, traits: doc.system?.traits?.value ?? [],
        basis: c.basis, environments: c.environments, notes: extractHabitatText(doc),
      });
    }
  }
  if (missingTotal) console.warn(`WARNING: ${missingTotal} art entr${missingTotal === 1 ? "y" : "ies"} skipped (no extracted doc).`);
  const tally = (list) => {
    const t = { total: list.length, prose: 0, traits: 0, unmapped: 0 };
    for (const r of list) t[r.basis === "prose" ? "prose" : r.basis === "traits" ? "traits" : "unmapped"]++;
    return t;
  };
  const fmt = (t) => `${t.total - t.unmapped}/${t.total} mapped (prose ${t.prose}, traits-only ${t.traits}, unmapped ${t.unmapped})`;
  const lines = ["# Creature environment audit", "", `Overall: ${fmt(tally(rows))}`, "", "## Per source pack", ""];
  for (const pack of packNames) lines.push(`- ${pack}: ${fmt(tally(rows.filter((r) => r.pack === pack)))}`);
  lines.push("", "## 25 random unmapped samples", "");
  sample(rows.filter((r) => r.basis === "none"), 25).forEach((r) => lines.push(`- ${r.name} (${r.id})`));
  lines.push("", "## 25 ambiguous samples (>=3 environments)", "");
  sample(rows.filter((r) => r.environments.length >= 3), 25)
    .forEach((r) => lines.push(`- ${r.name}: ${r.environments.join(", ")} [${r.basis}]`));
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, "creature-environments-report.md"), lines.join("\n") + "\n");
  writeFileSync(join(args.out, "creature-environments-candidates.json"), JSON.stringify(sortKeys(candidates), null, 2) + "\n");
  writeFileSync(join(args.out, "creature-environments-review.json"), JSON.stringify(review, null, 1) + "\n");
  console.log(lines.slice(2, 3).join(""));
  console.log(`Wrote report and candidates to ${args.out}`);
  if (args.merge) {
    const mapPath = join(ROOT, "data", "creature-environments.json");
    const srcPath = join(ROOT, "data", "creature-environments.sources.json");
    const r = mergeCandidates(
      JSON.parse(readFileSync(mapPath, "utf8")),
      JSON.parse(readFileSync(srcPath, "utf8")),
      candidates,
    );
    writeFileSync(mapPath, JSON.stringify(r.map, null, 2) + "\n");
    writeFileSync(srcPath, JSON.stringify(r.sources, null, 2) + "\n");
    console.log(`Merged ${r.added} new creature(s) into data/.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const systemPacksDir = process.env.PF2E_SYSTEM_PACKS_DIR ?? "/srv/foundry/data/Data/systems/pf2e/packs";
  if (!existsSync(systemPacksDir)) {
    console.error(`PF2E_SYSTEM_PACKS_DIR (${systemPacksDir}) does not exist; set it to a local pf2e install's packs dir. Nothing written.`);
    process.exit(1);
  }
  const art = JSON.parse(readFileSync(join(ROOT, "data", "creature-art.json"), "utf8"));
  const packNames = [...new Set(art.map((e) => e.pack))];
  const scratch = mkdtempSync(join(tmpdir(), "audit-env-"));
  try {
    if (args.probe) await probe(systemPacksDir, packNames, scratch);
    else await audit(args, art, packNames, systemPacksDir, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
