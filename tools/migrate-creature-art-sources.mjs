#!/usr/bin/env node
/**
 * One-shot, idempotent migration (#628): renames assets/creature-art/*.webp
 * into per-source subdirectories (pack minus "pf2e.", or shared/ for a file
 * used by more than one pack), and rewrites data/creature-art.json's
 * id/art fields plus tools/generate-token-art.mjs's per-entry dir: strings
 * to match. See docs/superpowers/specs/2026-10-04-creature-art-source-identifier-design.md.
 *
 * Run with --dry-run first -- prints the planned moves/rewrites without
 * touching anything. Safe to re-run for real: a file already at its
 * destination (gone from the old flat path) is skipped, not re-moved or
 * erroring, so an interrupted run can be resumed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = process.env.ART_MIGRATE_ROOT ? resolve(process.env.ART_MIGRATE_ROOT) : resolve(__dirname, "..");
const ART_DIR = resolve(root, "assets/creature-art");
const DATA_PATH = resolve(root, "data/creature-art.json");
const GENERATOR_PATH = resolve(root, "tools/generate-token-art.mjs");
const DRY_RUN = process.argv.includes("--dry-run");

function deriveSource(pack) {
  return pack.replace(/^pf2e\./, "");
}

function stripLobSuffix(id) {
  return id.replace(/_lob$/, "");
}

// Pulls just the filename back out of an `art` value that may already be
// migrated (`"<source>/<file>.webp"`) or still flat (`"<file>.webp"`) --
// grouping by this instead of the raw `art` string is what makes the rest
// of this script safe to re-run: a second pass must not treat an
// already-nested path as a brand-new bare filename to re-wrap.
function basenameOf(artPath) {
  return artPath.split("/").pop();
}

const creatureArt = JSON.parse(readFileSync(DATA_PATH, "utf8"));

// Group by basename -> set of distinct packs referencing it, to find
// which files are genuinely single-source vs shared across packs.
const artToPacks = new Map();
for (const e of creatureArt) {
  const basename = basenameOf(e.art);
  if (!artToPacks.has(basename)) artToPacks.set(basename, new Set());
  artToPacks.get(basename).add(e.pack);
}

const newRelativePath = new Map(); // basename -> new relative path
for (const [basename, packs] of artToPacks) {
  if (packs.size > 1) {
    newRelativePath.set(basename, `shared/${basename}`);
  } else {
    const [onlyPack] = packs;
    newRelativePath.set(basename, `${deriveSource(onlyPack)}/${basename}`);
  }
}

// Locate every referenced file (#628): index ALL .webp under ART_DIR (flat or
// nested) by basename. A file's CURRENT location is its single existing path;
// it may be flat (new art), nested at its destination (already migrated), or
// nested elsewhere (about to be promoted to shared/). Abort before moving
// anything if a basename is missing or exists at more than one path.
const existingByBasename = new Map();
if (existsSync(ART_DIR)) {
  for (const rel of readdirSync(ART_DIR, { recursive: true })) {
    const relPosix = rel.split("\\").join("/");
    if (!relPosix.endsWith(".webp")) continue;
    const b = basenameOf(relPosix);
    if (!existingByBasename.has(b)) existingByBasename.set(b, []);
    existingByBasename.get(b).push(relPosix);
  }
}
const currentPath = new Map(); // basename -> current relative path
const missing = [];
const duplicated = [];
for (const basename of newRelativePath.keys()) {
  const found = existingByBasename.get(basename) ?? [];
  if (found.length === 0) missing.push(basename);
  else if (found.length > 1) duplicated.push(`${basename}: ${found.join(", ")}`);
  else currentPath.set(basename, found[0]);
}
if (missing.length) {
  console.error(`${missing.length} creature-art.json entries reference files that exist nowhere under assets/creature-art (first 20): ${missing.slice(0, 20).join(", ")}`);
}
if (duplicated.length) {
  console.error(`${duplicated.length} referenced files exist at more than one path -- resolve manually, nothing was moved (first 20):\n  ${duplicated.slice(0, 20).join("\n  ")}`);
}
if (missing.length || duplicated.length) process.exit(1);

const sharedCount = [...artToPacks.values()].filter((packs) => packs.size > 1).length;
console.log(`${DRY_RUN ? "[dry-run] " : ""}${artToPacks.size} distinct art files, ${sharedCount} shared across packs`);

// --- Step 1: move the physical files -------------------------------------
let moved = 0;
let alreadyMoved = 0;
for (const [basename, newRelative] of newRelativePath) {
  const current = currentPath.get(basename);
  if (current === newRelative) {
    alreadyMoved += 1;
    continue;
  }
  const oldAbsolute = resolve(ART_DIR, current);
  const newAbsolute = resolve(ART_DIR, newRelative);
  if (DRY_RUN) {
    console.log(`git mv ${current} -> ${newRelative}`);
    moved += 1;
    continue;
  }
  mkdirSync(dirname(newAbsolute), { recursive: true });
  execFileSync("git", ["mv", oldAbsolute, newAbsolute], { cwd: root });
  moved += 1;
}
console.log(`${DRY_RUN ? "[dry-run] would move" : "moved"} ${moved} files, ${alreadyMoved} already at destination`);

// --- Step 2: rewrite data/creature-art.json -------------------------------
// Idempotency matters here: on a second run, e.art is already
// "<source>/<file>.webp" and e.id already has its "<source>__" prefix.
// Re-deriving from e.art directly (instead of its basename) would nest the
// path a second time, and re-prepending the prefix without checking for it
// first would double it up on the id too -- both confirmed as real bugs in
// an earlier draft of this script, caught by actually running it twice
// against the real data before this plan was finalized.
const updatedEntries = creatureArt.map((e) => {
  const basename = basenameOf(e.art);
  const newRelative = newRelativePath.get(basename);
  const source = newRelative.split("/")[0];
  const underscoredSource = source.replace(/-/g, "_");
  // A shared/ file serves several packs whose entries can differ only by a
  // stripped "_lob" suffix ("guard" vs "guard_lob"), so a shared entry's id
  // also carries its OWN pack's source to stay unique (#628).
  const expectedPrefix =
    source === "shared"
      ? `shared__${deriveSource(e.pack).replace(/-/g, "_")}__`
      : `${underscoredSource}__`;
  // Strip exactly the entry's CURRENT prefix (derived from its own current
  // art location, no guessing), then a trailing _lob, then add the new one.
  const [currentFolder, ...currentRest] = e.art.split("/");
  let currentPrefix = "";
  if (currentRest.length) {
    currentPrefix = currentFolder === "shared"
      ? `shared__${deriveSource(e.pack).replace(/-/g, "_")}__`
      : `${currentFolder.replace(/-/g, "_")}__`;
  }
  const unprefixed = currentPrefix && e.id.startsWith(currentPrefix) ? e.id.slice(currentPrefix.length) : e.id;
  const bareId = stripLobSuffix(unprefixed);
  return {
    ...e,
    id: `${expectedPrefix}${bareId}`,
    art: newRelative,
  };
});

if (DRY_RUN) {
  console.log(`[dry-run] would rewrite ${updatedEntries.length} creature-art.json entries`);
} else {
  writeFileSync(DATA_PATH, `${JSON.stringify(updatedEntries, null, 2)}\n`);
  console.log(`rewrote ${updatedEntries.length} creature-art.json entries`);
}

// --- Step 3: rewrite generate-token-art.mjs's per-entry dir: strings ------
const generatorSource = readFileSync(GENERATOR_PATH, "utf8");
const entryLinePattern = /\{ id: '([^']+)', file: '([^']+)', dir: 'assets\/creature-art'/g;
let rewrittenCount = 0;
let unmatchedFiles = [];
const rewrittenSource = generatorSource.replace(entryLinePattern, (fullMatch, _id, file) => {
  const basename = `${file}.webp`;
  const newRelative = newRelativePath.get(basename);
  if (!newRelative) {
    unmatchedFiles.push(file);
    return fullMatch; // no corresponding creature-art.json entry yet -- stays flat, per spec
  }
  rewrittenCount += 1;
  const newDir = `assets/creature-art/${dirname(newRelative)}`;
  return fullMatch.replace("dir: 'assets/creature-art'", `dir: '${newDir}'`);
});

if (DRY_RUN) {
  console.log(`[dry-run] would rewrite ${rewrittenCount} generate-token-art.mjs dir: entries, ${unmatchedFiles.length} left unmatched (stay flat): ${unmatchedFiles.join(", ")}`);
} else {
  writeFileSync(GENERATOR_PATH, rewrittenSource);
  console.log(`rewrote ${rewrittenCount} generate-token-art.mjs dir: entries, ${unmatchedFiles.length} left unmatched (stay flat): ${unmatchedFiles.join(", ")}`);
}
