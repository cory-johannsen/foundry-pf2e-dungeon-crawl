# Generated creature-art compendium pack — design

**Tracks:** [#599](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/599)

**Depends on:** #628 (creature-art source-identifier rename — merged; this spec assumes `data/creature-art.json`'s current post-#628 shape)

## Problem

Generated token art (`data/creature-art.json`, 5,904 entries) only ever gets applied at **token-spawn time**: `spawnCreatures()` (`scripts/foundry-api.mjs:803-882`) sets `img`/`prototypeToken.texture.src` on a freshly created *world* Actor copy, via `findCreatureArt()`/`creatureArtPath()` (`scripts/creature-art.mjs`). The original system compendium documents (`pf2e.pathfinder-monster-core`, etc.) are never touched. A GM browsing those packs directly in the sidebar, or dragging a creature onto a scene by hand instead of going through this module's spawn flow, never sees this project's generated art — only the original (often missing) art. `module.json`'s `"packs"` array is empty; this module ships none of its own compendium content today.

## Key discovery: full actor data isn't in this repo anywhere

`data/creature-art.json` only carries `{id, pack, docId, name, level, art}` — never a full actor document (stats, abilities, everything else a real Actor needs). Building real compendium Actor copies means reading that full data from somewhere. It doesn't exist in this repo; it only exists inside the `pf2e` system's own installed compendium packs.

Confirmed live on this host: the pf2e system's bestiary packs are real LevelDB directories at `/srv/foundry/data/Data/systems/pf2e/packs/<pack-name>/` (e.g. `pathfinder-monster-core/`, containing `.ldb`/`CURRENT`/`LOCK`/`LOG`/`MANIFEST-*` files — genuine LevelDB, not NeDB). The system's own `system.json` manifest confirms the exact pack-entry shape this project's own `module.json` needs to match: `{name, label, path, type, banner, system, ownership, flags}`, e.g. `{name: "pathfinder-monster-core", label: "Monster Core", path: "packs/pathfinder-monster-core", type: "Actor", banner: "systems/pf2e/assets/compendium-banner/red.webp", system: "pf2e", ownership: {PLAYER: "LIMITED", ASSISTANT: "OWNER"}, flags: {}}`.

## Key decision: read source data via `extractPack`, not `foundry-rest` — a deliberate deviation

Every prior use of "get data out of a pf2e compendium" in this codebase has gone through the live `foundry-rest` relay (`tools/generate-token-art.mjs`'s own comments confirm `creature-art.json` itself was originally populated this way). This spec deliberately does **not** follow that convention for this build script, for one concrete reason: the user has decided (2026-10-05) that this pack must be rebuilt on **every PR that touches `data/creature-art.json`** — not a periodic/occasional rebuild. Pulling 5,904 full actor documents through the REST relay on every single art-touching PR would be slow and would require a live Foundry world open for the entire build; this repo has no CI today (confirmed: PR checks report empty), so a build step that depends on a live, responsive Foundry world doesn't fit a step every contributor and every automated agent session runs constantly.

Instead, the build script reads source actor data directly off this host's installed pf2e system packs via `@foundryvtt/foundryvtt-cli`'s `extractPack` — a fully offline, officially-supported mechanism (the same tool the pf2e system's own maintainers use to manage their packs), confirmed via its real published API:

```js
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";
// extractPack(src, dest, options): options = { nedb: false, yaml: false, log, folders, transformEntry, transformName, transformSerialized }
// compilePack(src, dest, options): options = { nedb: false, yaml: false, log, recursive, transformEntry }
```

`nedb: false` (the default) is LevelDB mode, matching what these packs actually are.

This is a real, named architectural choice, not an oversight: this build script's job (compile a local redistributable pack from local system data) is categorically different from every prior `foundry-rest` use in this codebase (live investigation/verification against a running world). The two conventions can coexist — this spec doesn't change how any other tool in this repo talks to Foundry.

**Consequence:** the exact filesystem path to the pf2e system's packs is host-specific. It becomes a new `.env` variable, `PF2E_SYSTEM_PACKS_DIR`, following the existing `FOUNDRY_BASE_URL`/`FOUNDRY_REST_API_KEY` convention (`.claude/skills/foundry-rest/.env`), defaulting to `/srv/foundry/data/Data/systems/pf2e/packs` — this shared host's actual, confirmed layout, which every concurrent session (worker/worker-2/Art) already runs on identically.

## Scheme

**New pack:** a single Actor-type compendium, `generated-creature-art`, holding one Actor per `data/creature-art.json` entry (5,904 actors — every entry that file has, since it only ever contains creatures that already have generated art).

**`module.json`** gains one new entry in its `"packs"` array:

```json
{
  "name": "generated-creature-art",
  "label": "Generated Creature Art",
  "path": "packs/generated-creature-art",
  "type": "Actor",
  "system": "pf2e",
  "ownership": { "PLAYER": "LIMITED", "ASSISTANT": "OWNER" }
}
```

(Matches the pf2e system's own bestiary pack convention exactly — this is bestiary-equivalent content, not GM-secret content.)

**New build script, `tools/build-creature-art-pack.mjs`** (run via a new `npm run packs:build`):

1. Read `data/creature-art.json` (5,904 entries).
2. Group entries by `pack` (44 distinct values).
3. For each distinct `pack`, resolve its source directory as `${PF2E_SYSTEM_PACKS_DIR}/${pack.replace(/^pf2e\./, '')}` and `extractPack()` it once into a scratch directory (`tools/.pack-build-scratch/<pack-without-prefix>/`, not committed — see `.gitignore` below), reused across every entry that references that pack rather than re-extracting per entry.
4. For each distinct `pack`'s scratch directory, build a lookup map from `_id` → parsed document by reading every extracted JSON file and parsing its own `_id` field — confirmed via the installed `@foundryvtt/foundryvtt-cli@3.0.4` source (`extractClassicLevel`, `lib/package.mjs`) that an extracted file's *name* is `<safeName>_<id>.json` (derived from the document's `name`, not a predictable `<id>.json`), so the join must be done by parsing each file's content, not by guessing the filename. For each `data/creature-art.json` entry, look up its matching document by `docId` in that pack's map, deep-clone it, and override `img` and `prototypeToken.texture.src` to `modules/pf2e-dungeon-crawl/assets/creature-art/${entry.art}`. The entry's own `docId` is reused unchanged as this new document's `_id` — Foundry actor IDs are pack-scoped, not global, so reusing it carries no real collision risk and keeps the join back to `data/creature-art.json`'s own `docId` field (already the join key everywhere else in this codebase) direct and traceable.
5. Write each resulting document to `packs/generated-creature-art/_source/<docId>.json` — one human-readable file per actor, committed to git. This is `compilePack`'s own standard "unpacked source" convention, and keeping it in git (rather than treating it as scratch output) gives every PR a real, reviewable text diff for exactly which creatures' art changed, partially offsetting the fact that the compiled pack itself is binary.
6. `compilePack("packs/generated-creature-art/_source", "packs/generated-creature-art", { log: true })` — compiles the 5,904 source files into the real LevelDB pack Foundry reads at runtime. This directory is also committed to git: this module ships via a raw branch-zip download (`module.json`'s own `download` URL), with no separate release-build step, so whatever's in the repo is exactly what a GM gets.

**New `.gitignore` entry:** `tools/.pack-build-scratch/` (the per-pack `extractPack` scratch output from step 3 — intermediate, not the actual pack source, regenerated fresh on every build run).

**New `package.json`:**
- `devDependencies`: `"@foundryvtt/foundryvtt-cli": "^3.0.4"` (current published version, confirmed via `npm view @foundryvtt/foundryvtt-cli version`)
- `scripts`: `"packs:build": "node tools/build-creature-art-pack.mjs"`

**New `CLAUDE.md` rule** (same section/discipline as the existing version-bump rule):

> Any PR that changes `data/creature-art.json` must also run `npm run packs:build` and commit the resulting `packs/generated-creature-art/` (both its compiled LevelDB files and its `_source/*.json`) in the same PR. The compendium pack is a derived artifact of `data/creature-art.json` and must never be allowed to drift out of sync with it, the same way `module.json`'s version must never be left un-bumped after a merge.

## What does NOT need changes

- `scripts/creature-art.mjs` (`findCreatureArt`/`creatureArtPath`) and `scripts/foundry-api.mjs`'s `spawnCreatures` — the existing runtime spawn-time art-fallback mechanism is untouched. This spec is purely additive: a second, independent way to see the same generated art (browsing compendia) alongside the existing one (spawning a creature).
- `assets/creature-art/*.webp` — the art files themselves are only ever read, never moved or regenerated by this work.
- Any existing `tools/generate-token-art.mjs`/`tools/check-token-art.mjs`/`tools/validate-creature-art.mjs` logic — none of them produce or consume compendium packs; this is a new, independent tool alongside them.

## What DOES need changes

- `module.json` — new `packs` array entry (above).
- `package.json` — new devDependency, new `packs:build` script.
- `.gitignore` — new scratch-directory exclusion.
- `CLAUDE.md` — new enforcement rule (above).
- New files: `tools/build-creature-art-pack.mjs`, `packs/generated-creature-art/_source/*.json` (5,904 files), `packs/generated-creature-art/` (the compiled LevelDB pack).

## Deliberately out of scope

- **Keeping the pack in sync automatically (CI).** This repo has no CI today; standing one up is a separate, much larger effort unrelated to this feature. Sync is enforced by the new CLAUDE.md rule (a human/agent discipline, like the version bump), not by tooling that blocks a merge.
- **Any change to which creatures have generated art, or new art generation.** This is purely a redistribution step for art that already exists.
- **Multiple packs split by source book.** A single `generated-creature-art` pack holds everything; Foundry's compendium sidebar already supports searching/filtering a large pack, and splitting into 44 packs (one per source) would multiply every piece of this design (44 `module.json` entries, 44 build-script loops) for no concrete benefit identified.
- **Updating this pack's actors at runtime if a GM's world already has a token spawned from the *old* (pre-pack) flow.** Those existing world-actor copies are untouched by this spec; this only affects what a GM sees browsing the compendium sidebar or dragging a *fresh* copy onto a scene.


## Amendments from execution (2026-10-05)

Measuring the real build (all 5,904 entries against the real pf2e 8.5.0 packs) changed these parts of the design; see the plan's "Amendments" section for the exact rules:

- **Extract from a copy, never in place** (a live Foundry process holds the system packs open; opening them in place fails on the LevelDB lock or modifies system files).
- **Directory resolution via `system.json`** (`packs[].name -> path`), not `pack.replace("pf2e.", "")` (10 packs differ; one is referenced by the art data: `fall-of-plaguestone-bestiary -> packs/fall-of-plaguestone`).
- **The output actor `_id` is a derived unique id, not `docId`** (64 docIds are shared across source packs; reusing them collapses entries). Traceability: `flags["pf2e-dungeon-crawl"].artEntryId/sourcePack/sourceDocId` and the kept `_stats.compendiumSource`.
- **Embedded items are de-duplicated by `_id`** (two real pf2e actors list the same item twice, which `compilePack` rejects).
- **Sync policy:** the "every PR touching `data/creature-art.json`" rule is replaced by **rebuild at batch boundaries (an art batch/series finishing, or before a minor version bump) plus an offline `npm run packs:check` staleness report**, because a rebuild shares no file with the previous compiled pack (~61 MB of new git history each; Cory's decision after seeing the numbers). Measured totals: 5,904 actors, 115 MB source JSON (~21.5 MB compressed), one 61 MB compiled LevelDB file, ~15 s to build.
