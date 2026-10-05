# Creature Art Source-Identifier Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every creature-art file, `data/creature-art.json` entry, and `generate-token-art.mjs` table entry carries a real source identifier (derived from the existing `pack` field) instead of the current inconsistent `-lob`/plain-name mix — unblocking #599.

**Architecture:** A single, idempotent migration script does three things against the real repository data in one pass: `git mv`s every physical file from the flat `assets/creature-art/` into a per-source (or `shared/`, for the 166 files used by more than one pack) subdirectory; rewrites every `data/creature-art.json` entry's `id`/`art` fields to match; and rewrites `tools/generate-token-art.mjs`'s per-entry `dir:` strings via cross-reference, with zero changes to either file's own consuming/write-path logic (confirmed by reading both before this plan was written — `creatureArtPath()` already just concatenates, and `generate-token-art.mjs`'s write calls already just join whatever `dir` string they're given). Then the schema, validator, and asset-health tooling are updated to understand and enforce the new shape going forward.

**Tech Stack:** Vanilla JS/Node (`tools/migrate-creature-art-sources.mjs`, new), vitest, ajv (existing, for schema validation).

**Spec:** `docs/superpowers/specs/2026-10-04-creature-art-source-identifier-design.md`

## Global Constraints

- Source identifier = that entry's `pack` value with the universal `pf2e.` prefix stripped (every one of the 44 distinct pack values shares it) — never invented vocabulary, never a hand-maintained mapping table.
- A file referenced by `data/creature-art.json` entries from more than one distinct `pack` value goes in `assets/creature-art/shared/`, not duplicated into multiple source folders — measured at spec time as 166 of 4,787 distinct files, and 220 of 5,190 on 2026-10-05 (the share grows with the Art chunks; do not hard-code it).
- Filenames themselves stay bare (`<slug>.webp`) — the source identifier lives in the directory only, not duplicated into the filename too (spec's own explicit deviation from the issue's literal "both filename and folder" ask, already reviewed and approved).
- `id` becomes `<source_with_dashes_to_underscores>__<old_id_with_any_trailing_"_lob"_stripped>` — e.g. `pfs_season_1_bestiary__boggard_swampseer_pfs_1_24`. A `shared/` entry's id prefix is `shared__<its OWN pack source, dashes to underscores>__` (e.g. `shared__pfs_season_1_bestiary__guard`) — NOT a bare `shared__`: two entries in different packs can share one art file and differ only by the stripped `_lob` suffix (`guard` / `guard_lob`; 25 such pairs found at execution time), which would collide on `shared__guard`.
- The rename is a scripted `git mv` pass, not manual file moves — git must recognize each move as a rename (unchanged content, moved path), not a delete+add, so the history stays readable.
- **Counts are a moving target.** The Art sessions kept merging chunks after this plan was first written (4,787 files / 5,414 entries / 166 shared / 44 packs), and a re-measure on 2026-10-05 found **5,190 files, 5,904 entries, 220 shared files, 57 distinct packs**. Do NOT trust any hard-coded number: Task 1's dry-run must instead satisfy these invariants against whatever the repo holds at run time — (a) `distinct art files == files on disk` (zero orphans, zero missing); (b) `moved + already-at-destination == distinct art files`; (c) `creature-art.json entries rewritten == entry count`; (d) `generator entries rewritten + left unmatched == entries still carrying the literal flat dir: 'assets/creature-art'`; (e) destination directories == `distinct packs + 1` (the `shared/` folder). If any invariant fails, stop and find out why.
- **Added by Cory's decision (option A, 2026-10-05): a re-runnable normalizer, not a one-time fix.** The Art workflow lives OUTSIDE this repo (`~/src/art-tools/*.py` append flat-`dir` generator table entries and wire flat `art` values into `creature-art.json`), and the Art session that ran it has terminated. So `node tools/migrate-creature-art-sources.mjs` is the supported path for any new or leftover flat art — it must stay idempotent and handle flat entries added after the first run (Task 1), be reachable as `npm run art:normalize`, and be named in the validator/test failure messages (Task 2b).
- **Known consequence, accepted by the design:** tokens already placed in an existing world store the old flat path and will show broken images after this change; new spawns look art up by the new path and are fine. Say so in the PR and README.

## Review Focus

- **A file referenced by entries from different packs gets moved into only one of those packs' folders instead of `shared/`**, silently breaking the "every file in a real source folder is only ever used by that one source" invariant the spec exists to establish. Task 1's own dry-run step re-derives and prints the shared-file count before any real move happens, specifically so this is caught before it's irreversible, not after.
- **A `generate-token-art.mjs` table entry's `dir:` string gets rewritten for the wrong reason** — e.g. a false match on `file` collides with an unrelated creature that happens to share a slug. Task 1's rewrite only touches an entry whose `file` value, turned into `<file>.webp`, is an *exact* match against a real `creature-art.json` `art` basename — not a substring or fuzzy match — and the dry-run step prints the exact match/no-match counts and checks them against the `G + U == literal flat-dir entries` invariant before writing anything.
- **The migration script isn't actually idempotent** — re-running it after a partial or interrupted first run must skip already-moved files cleanly, not error or double-move. Task 1's own step explicitly re-runs the script a second time against the real, now-migrated repo state and confirms it reports everything already moved, nothing left to do.
- **The schema/validator changes land before the data they're meant to validate exists**, which would make every pre-migration entry fail validation the instant the schema tightens. Task 2 (schema/validator) is ordered strictly after Task 1 (the actual migration) for exactly this reason — not an arbitrary task order.
- **`tools/check-token-art.mjs`'s background-cleanliness check silently finds zero files** the moment everything moves into subdirectories, because its directory scan is non-recursive today — a tool that silently stops checking anything is worse than one that errors loudly, since nobody notices "no tokens yet" printed for a repo that actually has thousands. Task 2's fix is verified by confirming the post-fix file count matches an independent `find` count, not just that the tool runs without crashing.

---

## Task 1: Write and run the migration script

**Files:**
- Create: `tools/migrate-creature-art-sources.mjs`
- Modify (via the script, not by hand): `assets/creature-art/**/*.webp` (renamed in place), `data/creature-art.json`, `tools/generate-token-art.mjs`

**Interfaces:**
- Produces: a one-shot CLI tool, `node tools/migrate-creature-art-sources.mjs [--dry-run]`. No exports consumed by anything else — this is a migration tool, not reusable production logic (matching this repo's own existing precedent: none of `tools/generate-token-art.mjs`/`tools/check-token-art.mjs`/`tools/validate-creature-art.mjs` export anything either; each is verified by its effect on the real data, not by unit-testing its internals).

- [x] **Step 1: Write the script**

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

// Safety (#628): every referenced file must exist at its old flat path OR
// already at its destination. A file at neither would otherwise be silently
// counted as "already moved" -- abort before touching anything.
const missing = [];
for (const [basename, newRelative] of newRelativePath) {
  if (!existsSync(resolve(ART_DIR, basename)) && !existsSync(resolve(ART_DIR, newRelative))) {
    missing.push(basename);
  }
}
if (missing.length) {
  console.error(`${missing.length} creature-art.json entries reference files that exist at neither the flat path nor the new path (first 20): ${missing.slice(0, 20).join(", ")}`);
  process.exit(1);
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
    console.log(`git mv ${basename} -> ${newRelative}`);
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

- [x] **Step 2: Run in dry-run mode and confirm the counts match this plan's own pre-verified numbers**

Run: `node tools/migrate-creature-art-sources.mjs --dry-run`

Expected output (numbers are whatever the repo holds right now — check the invariants from Global Constraints, not fixed figures):
- `<N> distinct art files, <S> shared across packs` where `<N>` equals `ls assets/creature-art | grep -c '\.webp$'` (run that command and compare).
- `[dry-run] would move <M> files, <A> already at destination` with `M + A == N` (a fresh pre-migration repo gives `A == 0`).
- `[dry-run] would rewrite <E> creature-art.json entries` where `<E>` equals the entry count (`node -e "console.log(require('./data/creature-art.json').length)"`).
- `[dry-run] would rewrite <G> generate-token-art.mjs dir: entries, <U> left unmatched` where `G + U` equals `grep -c "dir: 'assets/creature-art'" tools/generate-token-art.mjs`.
- No `ReferenceError`, and no "exist at neither" abort.

Record the measured numbers in the report. If any invariant fails, or the numbers differ wildly from the 2026-10-05 snapshot (5,190 / 5,904 / 220 / 57), stop and find out why before proceeding.

- [x] **Step 3: Run for real**

Run: `node tools/migrate-creature-art-sources.mjs`

Expected: the same numbers as Step 2's dry-run, without the `[dry-run]` prefix, and the three real effects: files physically moved via `git mv`, `data/creature-art.json` rewritten, `tools/generate-token-art.mjs` rewritten.

- [x] **Step 4: Confirm idempotency by re-running immediately**

Run: `node tools/migrate-creature-art-sources.mjs`

Expected: `moved 0 files, <N> already at destination`, `rewrote <E> creature-art.json entries` (re-deriving the same already-correct ids/paths is harmless — this line always "succeeds" since it recomputes from the already-updated `art` field, which still resolves correctly through the same `newRelativePath` map), and `rewrote 0 generate-token-art.mjs dir: entries` (the literal string `dir: 'assets/creature-art'` the regex matches on no longer exists anywhere in the file after Step 3 rewrote it — nothing left to match, not an error).

- [x] **Step 5: Confirm git recognizes these as renames, not delete+add**

Run: `git status --short | head -20` and `git diff --stat | tail -5`
Expected: entries show as `R` (rename) for the moved files, not separate `D`/`A` pairs — `git mv` plus unchanged file content is exactly what git's own rename detection is built for.

- [ ] **Step 6: Run the existing asset-existence test to confirm every entry's new path actually resolves**

Run: `npx vitest run tests/creature-art-assets.test.mjs`
Expected: PASS (one case per entry) — this test already does `existsSync(resolve(ART_DIR, art))` for every entry with zero changes needed; if the migration left any entry's `art` field pointing at a path that doesn't exist, this is exactly what catches it.

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
Expected: `OK: <E> creature-art entries validate against schema` and `<E> unique creature-art entries, no duplicate lookup keys` — both already-existing checks, now exercised against the new `<source>/<filename>.webp` shape.

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
Expected: both report the same number, equal to Task 1's `<N>`.

- [ ] **Step 7: Commit**

```bash
git add data/schema/creature-art.schema.json tools/validate-creature-art.mjs tools/check-token-art.mjs
git commit -m "Enforce and scan the new per-source creature-art layout (#628)"
```

---

## Task 2b: Make the normalizer the supported, enforced path for new art (added 2026-10-05, option A)

**Files:**
- Modify: `package.json`
- Modify: `tools/validate-creature-art.mjs`
- Modify: `README.md`
- Create: `tests/creature-art-layout.test.mjs`

**Interfaces:** None new. Consumes the post-Task-1 data shape; produces the `npm run art:normalize` entry point that Task 3 and future Art work call.

- [ ] **Step 1: Add the npm script**

In `package.json` `scripts`, next to `"validate:creature-art"`, add:

```json
    "art:normalize": "node tools/migrate-creature-art-sources.mjs",
```

- [ ] **Step 2: Point validator failures at it**

In `tools/validate-creature-art.mjs`, define once near the top (after `const root = ...`):

```js
const NORMALIZE_HINT = 'Run `npm run art:normalize` (tools/migrate-creature-art-sources.mjs) to move new/flat art into its per-source folder and fix ids.';
```

and print `NORMALIZE_HINT` (via `console.error`) immediately before each of the two `process.exit(1)` paths that concern the `art` path: the schema-failure block (only when any `err.instancePath` ends with `/art`) and the `folderMismatches` block added in Task 2 Step 3. Leave the duplicate-id and duplicate-key blocks unchanged.

- [ ] **Step 3: Write the layout test (new, permanent CI enforcement)**

Create `tests/creature-art-layout.test.mjs`:

```js
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
    const bad = entries.filter((e) => !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\.webp$/.test(e.art));
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
});
```

(`import.meta.dirname` needs Node 20.11+; the repo already runs on Node 20 — if the suite's Node rejects it, use `dirname(fileURLToPath(import.meta.url))` like the tools do.)

- [ ] **Step 4: README note**

In `README.md`, directly under the existing "### Regenerating token art" code block, add:

```markdown
Art files live in per-source folders: `assets/creature-art/<source>/<slug>.webp`
(`<source>` = the entry's compendium `pack` without `pf2e.`; a file used by more
than one pack goes in `shared/`), and `data/creature-art.json` ids are prefixed
`<source>__`. New or flat art added by other tooling is normalized into that
layout with `npm run art:normalize` (idempotent; safe to re-run), and
`npm run validate:creature-art` plus `tests/creature-art-layout.test.mjs` fail
until it has been run. Note: tokens already placed in an existing world keep the
old flat path and show broken images until recreated; new spawns use the new path.
```

- [ ] **Step 5: Run the checks**

Run: `npx vitest run tests/creature-art-layout.test.mjs tests/creature-art-assets.test.mjs tests/creature-art.test.mjs && node tools/validate-creature-art.mjs`
Expected: PASS and all validator lines OK. Then prove the normalizer is the fix path: in a scratch copy is NOT needed — instead verify by reading that `NORMALIZE_HINT` is printed on the failure paths (`grep -n NORMALIZE_HINT tools/validate-creature-art.mjs` shows the definition plus both uses).

- [ ] **Step 6: Commit**

```bash
git add package.json tools/validate-creature-art.mjs README.md tests/creature-art-layout.test.mjs
git commit -m "Make art:normalize the supported path for new art; enforce layout in CI (#628)"
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
