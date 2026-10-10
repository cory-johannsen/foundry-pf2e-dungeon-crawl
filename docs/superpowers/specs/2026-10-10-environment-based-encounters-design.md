# Environment-Based Encounters

**Issue:** #1272 — choose creatures that fit the dungeon or encounter environment.

**Builds on:** `scripts/encounter-roster.mjs` (`pickCreature`, `creatureMatchesFilters`), `scripts/encounter-generator.mjs` (theme dialog, `generateForces`, `FILTER_NAMES`), `scripts/foundry-api.mjs` (`findCreatures`), `scripts/dungeon-scene.mjs` (`populateSlotEncounter`, run-wide `prefillTraits`), `scripts/ui/dungeon-app.mjs` (start-dungeon form), #1083 (multi-force builder, per-force filters), and the trait theme filter this sits beside.

**Related, not changed:** #750 / #764 (room art themes), #1043 (terrain Regions), #903 (time of day), #831 (depth bias).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

Creatures are currently picked by level, trait theme and rarity with no regard to where they live. This spec adds an **environment** to a dungeon run or stand-alone encounter, backed by a **committed, hand-reviewed creature-to-environment map** seeded by an audit tool. Selection prefers creatures whose environments include the chosen one, widens to adjacent environments when the pool is too small, and finally drops the filter. The PF2e encounter-budget rules stay the source of truth throughout.

## Investigation findings

- **No structured habitat data.** PF2e records habitat only as lore prose in the creature's description; `system.details` has no environment, terrain or biome field (verified by the issue author on a live Monster Core actor). Traits give a rough hint only (`aquatic`, `fire`, `plant`, `undead`).
- **Data quality is unmeasured.** The prose format and coverage across the ~1,600 bestiary creatures have not been audited; sampling needs a reader for the LevelDB packs, which is not installed in the repo. Measuring it is the first step of the audit tool below.
- **Where selection happens.** `pickCreature` in `encounter-roster.mjs` calls `api.findCreatures({ minLevel, maxLevel, traits, excludeTraits, packs, excludePacks, requireTrait, rarity })` through a relaxation chain: Monster Core packs with traits, general packs with traits, any pack with traits, any pack with no traits, then `null`. `creatureMatchesFilters` already applies per-force `rarity` (#1083), and `FILTER_NAMES` in `encounter-generator.mjs` lists the filters shown to the user.
- **Dungeon-wide settings flow through `populateSlotEncounter`.** A run's `traits` / `excludeTraits` are captured once at Start Dungeon (`dungeon-app.mjs`, stored on run state) and passed as `prefillTraits` / `prefillExcludeTraits` for every room, with no per-room dialog.
- **`LOCATION_TAGS` is not an environment.** `dungeon-deck.mjs` assigns each room a seeded creature-type tag (undead, beast, fiend, ...) that drives room art and an ANDed `requireTrait`. It stays as is; environment is an independent axis.

## Resolved decisions

1. **Data source:** a committed, hand-curated map `data/creature-environments.json`, seeded by an audit tool that reads each creature's habitat prose and traits, then reviewed and corrected by hand. Not runtime parsing and not traits alone.
2. **Assignment:** **dungeon-wide**. The GM picks an environment in the Start Dungeon form or leaves it on Random (seeded, reproducible). A stand-alone encounter picks it in the theme dialog. Rooms inherit the dungeon's environment; there is no per-room override.
3. **Fallback:** widen to **adjacent environments**, then drop the filter. The encounter budget and level band are unchanged, and the fallback taken is logged.
4. **Multi-force (#1083):** each force can set its own environment, defaulting to the encounter's.

## Design

### Environment vocabulary (`scripts/environments.mjs`, pure)

The closed list: `forest`, `swamp`, `cave`, `desert`, `urban`, `underwater`, `mountain`, `arctic`, `plains`, `underground-ruin`, `planar` (extraplanar), `any`. `any` marks creatures that fit everywhere (many humanoids, constructs, undead); an `any` creature matches every environment. Each environment has an ordered **adjacency list** used by the fallback, e.g. `swamp -> [forest, underwater]`, `cave -> [mountain, underground-ruin]`, `urban -> [plains, underground-ruin]`. Adjacency data and the vocabulary live in one exported constant; the localization labels live under `PF2EDC.Environment.*`.

Pure functions:

- `environmentsFor(slugOrId, map)` returns the creature's environment list, `["any"]` for mapped-as-any, or `null` when unmapped.
- `creatureFitsEnvironment(entry, environment, map)` is true when the creature is mapped to the environment or to `any`. Unmapped creatures are treated as **not fitting** in strict passes and **fitting** only in the final unfiltered pass (they are never silently excluded forever).
- `widenEnvironments(environment)` returns the ordered widening steps: `[[environment], [environment, ...adjacent]]`.

### Creature-to-environment map (`data/creature-environments.json`)

Shape: `{ version, creatures: { "<slug>": ["forest", "swamp"], ... } }`, keyed by the same creature slug the art pipeline already uses (`data/creature-art.json`), so one creature has one identity across data files. The file is hand-editable, schema-validated by a test, and never auto-regenerated over reviewed entries.

### Audit tool (`tools/audit-creature-environments.mjs`)

A one-shot, re-runnable generator, not a runtime dependency:

1. Reads every creature pack (the same packs `findCreatures` searches) via the local pf2e install (`PF2E_SYSTEM_PACKS_DIR`, same convention as `packs:build`).
2. For each creature, extracts a habitat line from the description prose using a documented set of patterns (e.g. a "Habitat" / "lives in" / "found in" sentence), maps found words to the vocabulary, and adds trait hints (`aquatic -> underwater`, `plant -> forest`, `fire/earth/air/water` elementals to their natural settings, `undead/construct -> any` unless prose says otherwise).
3. Writes a **report** (`out/creature-environments-report.md`, not committed): coverage (mapped / ambiguous / unmapped counts per source book), a sample of prose that matched nothing, and a candidate JSON.
4. With `--merge`, adds candidates to `data/creature-environments.json` **only for slugs not already present**, so hand corrections are never overwritten. Each merged entry is marked in a sibling `data/creature-environments.sources.json` (`"audit"` or `"manual"`) so reviewers can see what still needs a human look.

The audit report, not a guess, decides whether coverage is good enough; the plan must record the measured coverage on the issue. The tool is the place the issue's "data-quality check across the ~1,600 creatures" happens.

### Run and encounter settings

- **Start Dungeon form** (`dungeon-app.mjs`): an Environment select (`Random` default plus the vocabulary, `None`). `Random` resolves once from the run seed, so the same seed gives the same environment. The chosen value is stored on run state as `environment` (null for `None`) and read when populating each room.
- **`populateSlotEncounter`** passes `environment` from run state to the roster call alongside `prefillTraits`. It is an explicit parameter, not a trait, so the existing trait theme and `LOCATION_TAGS` keep working untouched.
- **Stand-alone theme dialog** (`encounter-generator.mjs`): an Environment select (default `None`) added next to the trait fields. With forces (#1083), each force row gets an Environment select defaulting to "same as encounter".
- **`None`** reproduces today's behavior exactly: no environment filter anywhere.

### Selection (`scripts/encounter-roster.mjs`)

`pickCreature` gains `environment = null` and `environmentMap`. `findCreatures` results (an index list) are filtered with `creatureFitsEnvironment` after the existing trait/level/rarity filtering, so no change to `findCreatures` itself. The relaxation chain becomes two-dimensional:

1. For each existing pack/trait step, try **strict environment** first, then **adjacent environments** (`widenEnvironments`).
2. Only after every pack/trait step has failed with the environment constraint does the chain **drop the environment** and run the existing steps again.
3. The environment is relaxed before the trait theme and `requireTrait` are. Trait/location intent is explicit user or seeded identity; environment is a preference layered on top.

Each pick records which step satisfied it (`environmentMatch: "strict" | "adjacent" | "dropped" | "none"`) on the returned entry. The existing encounter summary line (and the stand-alone chat card) shows a one-line note when any slot used `adjacent` or `dropped`, e.g. "Environment: 2 of 4 creatures from adjacent environments."

The level band, XP budget and creature count logic are not touched. The environment only narrows which creatures are eligible inside the band, and the fallback only widens eligibility.

### Multi-force builder (#1083)

`creatureMatchesFilters` gains `environment` (and the map). `FILTER_NAMES` gains `["environment", (f) => !!f.environment]` so the per-force filter summary lists it. A force's own environment overrides the encounter's; a force set to "same as encounter" inherits.

### Localization

`PF2EDC.Environment.*` labels for each environment, `PF2EDC.Environment.None`, `PF2EDC.Environment.Random`, the form label and hint, and the fallback note strings.

## Error handling

- A missing or malformed `data/creature-environments.json` reads as an empty map; an environment then matches nothing in the strict passes and the chain falls through to `dropped`, i.e. today's behavior, with one console warning.
- An unknown environment value in run state (e.g. from an older save or hand edit) is treated as `None`.
- The audit tool never writes outside `data/` and `out/`, and aborts without writing if the packs directory is missing.

## Testing

- **Vocabulary and adjacency (pure):** every environment has an adjacency list of valid ids, no self-adjacency, `any` matches all.
- **`creatureFitsEnvironment`:** mapped, `any`, unmapped (strict pass excludes, final pass includes).
- **`pickCreature` with a stub `findCreatures`:** strict hit; strict empty then adjacent hit; adjacent empty then environment dropped; environment relaxed before traits and `requireTrait`; `None` identical to the pre-change chain (golden test over the existing roster tests); boss path.
- **Determinism:** the same seed gives the same `Random` environment and the same room picks.
- **Fallback note:** appears only when a slot used adjacent or dropped.
- **Forces:** per-force override, inherit, and `FILTER_NAMES` display.
- **Map file:** schema test (valid environment ids, slugs exist in `creature-art.json`, no duplicates); `.sources.json` matches.
- **Audit tool:** extraction patterns against fixture prose, trait hints, `--merge` never overwrites an existing slug, report coverage counts.
- **Regression:** budget math, depth bias, `LOCATION_TAGS` / `requireTrait`, rarity filter, and stand-alone trait theme behave as before when no environment is set.
- **Live verification:** start a dungeon with Swamp and confirm the rooms' creatures are swamp-appropriate or the summary notes a fallback; a stand-alone Underwater encounter; a two-force encounter with different environments; `None` unchanged.

## Explicitly out of scope

- Per-room environments or overrides (decision 2), and tying the environment to room art (#750 / #764) or terrain Regions (#1043).
- Environment-specific hazards, weather or lighting; time of day (#903).
- Changing XP budgets or level selection (#831).
- Editing the compendium actors themselves.

## Open questions

None blocking. Left to planning: the exact habitat-prose patterns (determined by the audit's first run), the final adjacency table, and whether `Random` should weight environments by how many creatures each has so a thin environment is not drawn too often.
