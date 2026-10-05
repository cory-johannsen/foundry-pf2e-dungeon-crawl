# Creature art source-identifier rename and directory restructure — design

**Tracks:** [#628](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/628)

**Blocks:** #599 (module compendium pack — needs names that map 1:1 onto compendium entries)

## Problem

`assets/creature-art/` (~3,860 files, indexed by `data/creature-art.json`'s 5,394 entries) has inconsistent source naming — a `-lob` suffix copied onto files where it no longer meant anything, plain names from PFS Season 5 onward, and no reliable way to tell which source book/pack a given image came from. #599 needs every entry's art to map cleanly onto its source compendium; this doesn't exist today.

## Key discovery: the source identifier already exists in the data

Every one of the 5,394 `data/creature-art.json` entries already carries a real, canonical `pack` field (`pf2e.pathfinder-monster-core`, `pf2e.pfs-season-5-bestiary`, etc.) — confirmed live against the actual data file, zero missing/null values, 44 distinct values. There is no vocabulary to invent: the source identifier is the `pack` value with its universal `pf2e.` prefix stripped (every single value shares that prefix, so stripping it is lossless).

Only 5 of the 44 packs have fewer than 20 entries (52 entries total, under 1% of all entries) — not enough to justify a grouping/`misc` bucket. Every pack gets its own folder, including the small ones.

## Key discovery: art files aren't always owned by one source

166 of the 4,767 distinct art files (3.5%) are referenced by `creature-art.json` entries from **multiple different packs** — e.g. `goblin-warrior.webp` is used by both `pf2e.pathfinder-monster-core` and three different PFS season bestiaries, because this project's own art-reuse tooling already dedupes identical creature art across sources rather than regenerating the same image per pack.

**Decision (user, 2026-10-04):** these 166 files go in a dedicated `assets/creature-art/shared/` folder rather than being duplicated into every referencing pack's folder. Avoids ~166 duplicate files and the maintenance burden of keeping copies in sync if that art is ever regenerated; every other per-source folder stays honestly "every file in here is only ever used by this one source."

## Scheme

- **Source identifier:** `pack` value with `pf2e.` stripped (e.g. `pathfinder-monster-core`, `pfs-season-5-bestiary`, `lost-omens-bestiary`). A file referenced by more than one distinct pack value uses `shared` instead of any real source.
- **Directory:** `assets/creature-art/<source>/<filename>.webp`, or `assets/creature-art/shared/<filename>.webp`.
- **Filename:** stays bare (`<slug>.webp`, no source prefix baked into the filename itself) — the folder is the source indicator. The issue's own suggestion of also prefixing the filename (`<source>--<slug>.webp`, "self-describing when copied out of its folder") is explicitly **not** done: a `shared/` file has no single source to prefix with by definition, and doubling the source into every other file's name as well, when the folder already disambiguates it unambiguously, adds length and redundancy for no real benefit. If this trade-off is wrong, say so when reviewing this spec — it's a late addition to the issue's own original ask, not a load-bearing requirement from #599.
- **`creature-art.json` `id` field:** gains a `<source_with_underscores>__` prefix (double underscore, to stand out from the single underscores already inside slugs), with the old `_lob` suffix stripped — e.g. `boggard_swampseer_pfs_1_24_lob` (pack `pf2e.pfs-season-1-bestiary`) becomes `pfs_season_1_bestiary__boggard_swampseer_pfs_1_24`. A `shared/` entry's id gets `shared__<own_pack_source_with_underscores>__` instead (e.g. `shared__pfs_season_1_bestiary__guard`): a shared file serves several packs whose entries can differ only by the stripped `_lob` suffix (`guard` / `guard_lob`), so the entry's *own* pack source is kept in its id to stay unique (found during #628 execution, 25 such pairs). This still matches the schema's existing `id` pattern (`^[a-z][a-z0-9_]*$`) with no schema change needed for that field.
- **`creature-art.json` `art` field:** becomes the path relative to `assets/creature-art/` including the new subdirectory — `pathfinder-monster-core/homunculus.webp`, `shared/goblin-warrior.webp` — instead of today's bare filename.

## What does NOT need code changes

- **`scripts/creature-art.mjs`** — `creatureArtPath(filename)` already does exactly `${ART_DIR}/${filename}`; once the `art` field's *value* includes the subdirectory, this function's own logic is already correct with zero changes. `findCreatureArt`'s lookup key is `{pack, docId}`, never the `id` or `art` string directly — also unaffected.
- **`tools/generate-token-art.mjs`'s write-path mechanics** — confirmed by reading the actual write call sites (`dirFor(s) = s.dir ? join(root, s.dir) : OUT_DIR`, and `join(outDir, \`${s.file}.webp\`)`): both already just join whatever string `s.dir` holds with `root`. As long as each table entry's `dir` *string value* is updated to the correct new subdirectory, none of the surrounding generation/write logic needs to change at all.

## What does need changes

- **`assets/creature-art/*.webp` (the files themselves)** — moved via `git mv` into their new per-source (or `shared/`) subdirectory.
- **`data/creature-art.json`** — every entry's `id` and `art` fields rewritten per the scheme above.
- **`data/schema/creature-art.schema.json`** — the `art` property's pattern (`^[a-z][a-z0-9-]*\\.webp$`, bare-filename-only, no `/` allowed today) must allow a `<source>/<filename>.webp` path; its description ("Bare filename under assets/creature-art/, not a full module path") must be corrected to describe the new shape.
- **`tools/generate-token-art.mjs`**'s `MONSTER_ART` table (hundreds of entries, each currently hardcoding the literal string `dir: 'assets/creature-art'`, with **no** `pack` field of its own) — each entry's `dir:` string gets rewritten to the correct new subdirectory, computed by cross-referencing that entry's `id`/`file` slug against `creature-art.json`'s `art` basename to find which pack(s) use it (and therefore which source/`shared` folder it belongs in). This is a scripted text-level rewrite of the source file, not a manual one — there is no other field in this table to drive it from directly.
- **`tools/check-token-art.mjs`** — its directory scan (`readdirSync(dir)` on `assets/creature-art`, currently non-recursive) must become recursive, or it will find zero files the moment everything moves into subdirectories.
- **`tools/validate-creature-art.mjs`** — gains a new check enforcing the folder/pack agreement the issue asks for: every entry's `art` path's leading directory component must equal either that entry's own derived source (`pack` minus `pf2e.`) or `shared` (only when the same `art` basename is genuinely referenced by more than one distinct pack elsewhere in the file).

## Migration approach

A single, idempotent, re-runnable Node script (not a one-off interactive process) that:

1. Reads `data/creature-art.json`.
2. Computes each entry's derived source (`pack.replace(/^pf2e\./, '')`).
3. Groups entries by `art` basename to find which ones are referenced by more than one distinct `pack` — those become `shared`; everything else uses its own derived source.
4. For each **distinct physical file** (not each entry — a shared file is moved once, not once per referencing entry), computes its new relative path and runs `git mv` from the old flat location to the new one.
5. Rewrites every entry's `id` (prefix + strip `_lob`) and `art` (new relative path) in place, writing `data/creature-art.json` back out.
6. Cross-references `tools/generate-token-art.mjs`'s `MONSTER_ART` table entries by `id`/`file` against the now-updated `creature-art.json` (matching on the `art` basename) and rewrites each matched entry's `dir:` string in the source text.
7. Is safe to re-run: if a file has already moved (destination exists, source doesn't), that entry is skipped rather than erroring, so a partial/interrupted run can be resumed.

Deliberately **not** done in this spec:

- No change to which images exist, what they depict, or any new generation — this is a pure rename/reorganization of already-generated art.
- No attempt to further verify or improve art quality (`tools/check-token-art.mjs`'s background-cleanliness check) as part of this migration — it's updated only so it can still find the files at all.
- No change to the `MONSTER_ART` table entries that have no corresponding `creature-art.json` entry yet (not-yet-generated creatures) — those keep the flat `assets/creature-art` default, since there's nothing to cross-reference them against yet; they'll get a real subdirectory the first time `tools/generate-token-art.mjs` actually generates art for them, once that script is updated to default new output into the correct per-source folder going forward (tracked as this spec's own tooling-update task, not deferred).

## Coordination

Per the issue's own explicit callout: the `art`/`Art` peer sessions are the ones actively adding new creature-art entries. Both show idle at the time this spec was written (confirmed via `ListAgents`), but the migration script in the implementation plan should be run as close as possible to being claimed/started to minimize the window where a concurrent session could add a new flat-named file this migration's own cross-referencing wouldn't see.

## Testing

- `tools/validate-creature-art.mjs`'s existing schema/duplicate-id/duplicate-key checks, plus its new folder-agreement check, run against the real post-migration `data/creature-art.json` — this is the primary correctness gate for the data half of the migration (5,394 real entries, not a synthetic fixture).
- `tools/check-token-art.mjs`'s recursive-walk fix is verified by confirming it finds the same total file count after migration as `find assets/creature-art -name '*.webp' | wc -l` reports independently.
- The migration script itself is exercised against the real repository data (there's no separate "test" data set smaller than the real 3,860 files that would actually prove the rename logic correct) — verified via `git status`/`git diff --stat` showing exactly the expected renames (git recognizes a `git mv` with unchanged content as a rename, not a delete+add, so this is also how the PR diff should look), and a final `git mv`-count check against the computed migration plan's own expected count.
