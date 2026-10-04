# Creature Art Source-Identifier Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every creature-art file, `data/creature-art.json` entry, and `generate-token-art.mjs` table entry carries a real source identifier (derived from the existing `pack` field) instead of the current inconsistent `-lob`/plain-name mix — unblocking #599.

**Architecture:** A single, idempotent migration script does three things against the real repository data in one pass: `git mv`s every physical file from the flat `assets/creature-art/` into a per-source (or `shared/`, for the 166 files used by more than one pack) subdirectory; rewrites every `data/creature-art.json` entry's `id`/`art` fields to match; and rewrites `tools/generate-token-art.mjs`'s per-entry `dir:` strings via cross-reference, with zero changes to either file's own consuming/write-path logic (confirmed by reading both before this plan was written — `creatureArtPath()` already just concatenates, and `generate-token-art.mjs`'s write calls already just join whatever `dir` string they're given). Then the schema, validator, and asset-health tooling are updated to understand and enforce the new shape going forward.

**Tech Stack:** Vanilla JS/Node (`tools/migrate-creature-art-sources.mjs`, new), vitest, ajv (existing, for schema validation).

**Spec:** `docs/superpowers/specs/2026-10-04-creature-art-source-identifier-design.md`

## Global Constraints

- Source identifier = that entry's `pack` value with the universal `pf2e.` prefix stripped (every one of the 44 distinct pack values shares it) — never invented vocabulary, never a hand-maintained mapping table.
- A file referenced by `data/creature-art.json` entries from more than one distinct `pack` value goes in `assets/creature-art/shared/`, not duplicated into multiple source folders — confirmed at spec time: 166 of 4,787 distinct files.
- Filenames themselves stay bare (`<slug>.webp`) — the source identifier lives in the directory only, not duplicated into the filename too (spec's own explicit deviation from the issue's literal "both filename and folder" ask, already reviewed and approved).
- `id` becomes `<source_with_dashes_to_underscores>__<old_id_with_any_trailing_"_lob"_stripped>` — e.g. `pfs_season_1_bestiary__boggard_swampseer_pfs_1_24`. A `shared/` entry's id prefix is `shared__`.
- The rename is a scripted `git mv` pass, not manual file moves — git must recognize each move as a rename (unchanged content, moved path), not a delete+add, so the history stays readable.
- Confirmed by direct, read-only dry-run analysis against the real repository data before this plan was written (re-verify these exact counts in Task 1's own dry-run step — if they differ, the underlying data changed since this plan was written, most likely from the Art session's own concurrent work, and the plan's own numbers are stale, not wrong in design): **4,787 distinct art files referenced, 4,787 files on disk (zero orphans, zero missing), 45 destination directories (44 real sources + `shared/`), 166 files in `shared/`, 3,702 `generate-token-art.mjs` table entries carry the literal `dir: 'assets/creature-art'` string, of which 3,693 match a real `creature-art.json` entry (the other 9 are pre-existing not-yet-generated entries and are left untouched, per the spec).**

## Review Focus

- **A file referenced by entries from different packs gets moved into only one of those packs' folders instead of `shared/`**, silently breaking the "every file in a real source folder is only ever used by that one source" invariant the spec exists to establish. Task 1's own dry-run step re-derives and prints the shared-file count before any real move happens, specifically so this is caught before it's irreversible, not after.
- **A `generate-token-art.mjs` table entry's `dir:` string gets rewritten for the wrong reason** — e.g. a false match on `file` collides with an unrelated creature that happens to share a slug. Task 1's rewrite only touches an entry whose `file` value, turned into `<file>.webp`, is an *exact* match against a real `creature-art.json` `art` basename — not a substring or fuzzy match — and the dry-run step prints the exact match/no-match counts to catch a discrepancy from the pre-verified 3,693/9 split before writing anything.
- **The migration script isn't actually idempotent** — re-running it after a partial or interrupted first run must skip already-moved files cleanly, not error or double-move. Task 1's own step explicitly re-runs the script a second time against the real, now-migrated repo state and confirms it reports everything already moved, nothing left to do.
- **The schema/validator changes land before the data they're meant to validate exists**, which would make every one of the 5,414 pre-migration entries fail validation the instant the schema tightens. Task 2 (schema/validator) is ordered strictly after Task 1 (the actual migration) for exactly this reason — not an arbitrary task order.
- **`tools/check-token-art.mjs`'s background-cleanliness check silently finds zero files** the moment everything moves into subdirectories, because its directory scan is non-recursive today — a tool that silently stops checking anything is worse than one that errors loudly, since nobody notices "no tokens yet" printed for a repo that actually has thousands. Task 2's fix is verified by confirming the post-fix file count matches an independent `find` count, not just that the tool runs without crashing.

---

## Task 1: Write and run the migration script

**Files:**
- Create: `tools/migrate-creature-art-sources.mjs`
- Modify (via the script, not by hand): `assets/creature-art/**/*.webp` (renamed in place), `data/creature-art.json`, `tools/generate-token-art.mjs`

**Interfaces:**
- Produces: a one-shot CLI tool, `node tools/migrate-creature-art-sources.mjs [--dry-run]`. No exports consumed by anything else — this is a migration tool, not reusable production logic (matching this repo's own existing precedent: none of `tools/generate-token-art.mjs`/`tools/check-token-art.mjs`/`tools/validate-creature-art.mjs` export anything either; each is verified by its effect on the real data, not by unit-testing its internals).

- [ ] **Step 1: Write the script**

```js
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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
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

const sharedCount = [...artToPacks.values()].filter((packs) => packs.size > 1).length;
console.log(`${DRY_RUN ? "[dry-run] " : ""}${artToPacks.size} distinct art files, ${sharedCount} shared across packs`);

// --- Step 1: move the physical files -------------------------------------
let moved = 0;
let alreadyMoved = 0;
for (const [basename, newRelative] of newRelativePath) {
  const oldAbsolute = resolve(ART_DIR, basename); // the flat, pre-migration location
  const newAbsolute = resolve(ART_DIR, newRelative);
  if (!existsSync(oldAbsolute)) {
    alreadyMoved += 1;
    continue;
  }
  if (DRY_RUN) {
    console.log(`git mv ${oldBasename} -> ${newRelative}`);
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
  const expectedPrefix = `${underscoredSource}__`;
  const bareId = e.id.startsWith(expectedPrefix)
    ? e.id.slice(expectedPrefix.length)
    : stripLobSuffix(e.id);
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
```

- [ ] **Step 2: Run in dry-run mode and confirm the counts match this plan's own pre-verified numbers**

Run: `node tools/migrate-creature-art-sources.mjs --dry-run`

Expected output matching this plan's Global Constraints section (re-derive, don't just trust the plan's own numbers — the repo may have changed since this plan was written):
- `4787 distinct art files, 166 shared across packs`
- `[dry-run] would move 4787 files, 0 already at destination`
- `[dry-run] would rewrite 5414 creature-art.json entries`
- `[dry-run] would rewrite 3693 generate-token-art.mjs dir: entries, 9 left unmatched`

If any of these numbers differ from this plan's own pre-verified figures, stop and re-derive why before proceeding (most likely cause: the Art session added or changed entries since this plan was written) — do not proceed on a mismatch without understanding it first.

- [ ] **Step 3: Run for real**

Run: `node tools/migrate-creature-art-sources.mjs`

Expected: the same counts as Step 2's dry-run, without the `[dry-run]` prefix, and the three real effects: files physically moved via `git mv`, `data/creature-art.json` rewritten, `tools/generate-token-art.mjs` rewritten.

- [ ] **Step 4: Confirm idempotency by re-running immediately**

Run: `node tools/migrate-creature-art-sources.mjs`

Expected: `moved 0 files, 4787 already at destination`, `rewrote 5414 creature-art.json entries` (re-deriving the same already-correct ids/paths is harmless — this line always "succeeds" since it recomputes from the already-updated `art` field, which still resolves correctly through the same `newRelativePath` map), and `rewrote 0 generate-token-art.mjs dir: entries` (the literal string `dir: 'assets/creature-art'` the regex matches on no longer exists anywhere in the file after Step 3 rewrote it — nothing left to match, not an error).

- [ ] **Step 5: Confirm git recognizes these as renames, not delete+add**

Run: `git status --short | head -20` and `git diff --stat | tail -5`
Expected: entries show as `R` (rename) for the moved files, not separate `D`/`A` pairs — `git mv` plus unchanged file content is exactly what git's own rename detection is built for.

- [ ] **Step 6: Run the existing asset-existence test to confirm every entry's new path actually resolves**

Run: `npx vitest run tests/creature-art-assets.test.mjs`
Expected: PASS (all 5,414+ cases) — this test already does `existsSync(resolve(ART_DIR, art))` for every entry with zero changes needed; if the migration left any entry's `art` field pointing at a path that doesn't exist, this is exactly what catches it.

- [ ] **Step 7: Commit**

```bash
git add tools/migrate-creature-art-sources.mjs assets/creature-art data/creature-art.json tools/generate-token-art.mjs
git commit -m "Migrate creature-art files/ids to per-source directories (#628)"
```

---

## Task 2: Update the schema, validator, and asset-health tooling for the new scheme

**Files:**
- Modify: `data/schema/creature-art.schema.json`
- Modify: `tools/validate-creature-art.mjs`
- Modify: `tools/check-token-art.mjs`

**Interfaces:** None new — this task only tightens validation of the data Task 1 already produced.

- [ ] **Step 1: Update the schema's `art` pattern and description**

In `data/schema/creature-art.schema.json`, change:

```json
        "art": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]*\\.webp$",
          "description": "Bare filename under assets/creature-art/, not a full module path."
        }
```

to:

```json
        "art": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*\\.webp$",
          "description": "Path relative to assets/creature-art/, as <source>/<filename>.webp or shared/<filename>.webp -- never a bare filename (#628)."
        }
```

- [ ] **Step 2: Run the existing validator to confirm the post-migration data passes the tightened schema**

Run: `node tools/validate-creature-art.mjs`
Expected: `OK: 5414 creature-art entries validate against schema` and `5414 unique creature-art entries, no duplicate lookup keys` — both already-existing checks, now exercised against the new `<source>/<filename>.webp` shape.

- [ ] **Step 3: Add the folder/pack-agreement check**

In `tools/validate-creature-art.mjs`, add after the existing duplicate-key check (the file's last block):

```js
const folderMismatches = [];
const artToPacksForValidation = new Map();
for (const entry of creatureArt) {
  if (!artToPacksForValidation.has(entry.art)) artToPacksForValidation.set(entry.art, new Set());
  artToPacksForValidation.get(entry.art).add(entry.pack);
}
for (const entry of creatureArt) {
  const [folder] = entry.art.split('/');
  const expectedSource = entry.pack.replace(/^pf2e\./, '');
  const packsForThisArt = artToPacksForValidation.get(entry.art);
  const isGenuinelyShared = packsForThisArt.size > 1;
  if (isGenuinelyShared) {
    if (folder !== 'shared') {
      folderMismatches.push(`${entry.id}: art "${entry.art}" is referenced by ${packsForThisArt.size} distinct packs but isn't under shared/`);
    }
  } else if (folder !== expectedSource) {
    folderMismatches.push(`${entry.id}: art "${entry.art}" is in "${folder}/" but its pack (${entry.pack}) derives source "${expectedSource}/"`);
  }
}
if (folderMismatches.length) {
  console.error(`Folder/pack mismatches:\n  ${folderMismatches.join('\n  ')}`);
  process.exit(1);
}
console.log(`${creatureArt.length} entries' art paths agree with their own pack's derived source (or shared/)`);
```

- [ ] **Step 4: Run the validator again to confirm the new check passes on the real, migrated data**

Run: `node tools/validate-creature-art.mjs`
Expected: all four checks print OK, including the new `entries' art paths agree...` line.

- [ ] **Step 5: Make `check-token-art.mjs`'s directory scan recursive**

In `tools/check-token-art.mjs`, change:

```js
const files = dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => f.endsWith('.webp')).map((f) => join(dir, f)));
```

to:

```js
const files = dirs.flatMap((dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : [])
  .filter((f) => f.endsWith('.webp')).map((f) => join(dir, f)));
```

(`readdirSync`'s `{ recursive: true }` option, available since Node 18.17, returns paths relative to `dir` including any subdirectory — `join(dir, f)` already handles that correctly with no further change needed.)

- [ ] **Step 6: Confirm the recursive scan finds the same total count as an independent `find`**

Run: `node -e "const {readdirSync}=require('node:fs'); console.log(readdirSync('assets/creature-art',{recursive:true}).filter(f=>f.endsWith('.webp')).length)"` and separately `find assets/creature-art -name '*.webp' | wc -l`
Expected: both report the same number (4,787, per Task 1's own migration — re-confirm the live count rather than assuming it's still exactly that, in case anything changed between tasks).

- [ ] **Step 7: Commit**

```bash
git add data/schema/creature-art.schema.json tools/validate-creature-art.mjs tools/check-token-art.mjs
git commit -m "Enforce and scan the new per-source creature-art layout (#628)"
```

---

## Task 3: Full-suite verification and report

**Files:** None — this task only runs existing tooling/tests and reports the outcome.

**Interfaces:** None.

- [ ] **Step 1: Run the full vitest suite**

Run: `npx vitest run`
Expected: PASS — `tests/creature-art-assets.test.mjs` already re-verified in Task 1; this step catches any other test anywhere in the suite that happened to assert on a bare `assets/creature-art/<slug>.webp` path or the old `-lob`-suffixed id shape, which this plan's own research didn't surface but a full run would.

- [ ] **Step 2: Run the token-art background-health check**

Run: `npm run tokens:check` (or `node tools/check-token-art.mjs` directly)
Expected: completes and reports real per-file results (not "no tokens yet") across every subdirectory, confirming Task 2's recursive-scan fix actually works end to end against the real, now-nested files — not just the isolated count-match check from Task 2 Step 6.

- [ ] **Step 3: Report the outcome on issue #628**

Comment on #628 with the real final counts (files moved, entries rewritten, generator entries rewritten, any of the 9 unmatched generator entries worth noting by name) and confirmation that the full suite and both tooling scripts pass against the real, migrated repository — before removing its `planned` label in favor of whatever this repo's lifecycle calls for once an implementer picks this up.
