# Environment-Based Encounters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dungeon run or stand-alone encounter have an environment, and choose creatures that fit it, backed by a committed, hand-reviewed creature-to-environment map (#1272).

**Architecture:** A pure `scripts/environments.mjs` (vocabulary, adjacency, fit checks, lookup, seeded random choice) plus `data/creature-environments.json` keyed by the creature-art `id`. `pickCreature` gains an environment dimension on top of its pack/trait relaxation chain: strict → adjacent → (only after every pack/trait step failed) drop the environment. A one-shot audit tool seeds the map from pf2e pack prose and traits. Environment flows from the Start Dungeon form (run-wide, `Random` seeded) and from the stand-alone/forces dialog into `generateEncounterRoster`.

**Tech Stack:** Foundry VTT v13 module, ES modules, Vitest, `@foundryvtt/foundryvtt-cli` (`extractPack`) for the audit tool.

**Spec:** `docs/superpowers/specs/2026-10-10-environment-based-encounters-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json` `version` (currently `0.95.8`; feature → minor bump unless the owner says otherwise; re-read `origin/main` at merge time, never reuse a number).
- Run the `update-architecture-docs` skill in the same PR (new `scripts/environments.mjs` and new imports in `encounter-roster.mjs`, `encounter-generator.mjs`, `data-loader.mjs`, `dungeon-runner.mjs`, `dungeon-scene.mjs`, `ui/dungeon-app.mjs`).
- Environment vocabulary (closed): `forest, swamp, cave, desert, urban, underwater, mountain, arctic, plains, underground-ruin, planar, any`. `any` matches every environment.
- PF2e budget rules stay the source of truth: the level band, XP budget and creature count logic are untouched; environment only changes which creatures are eligible inside the band.
- `None` (no environment) must reproduce today's behavior exactly (golden regression).
- `LOCATION_TAGS`/`requireTrait` and the trait theme are untouched; environment is relaxed **before** traits and `requireTrait`.
- `data/creature-environments.json` is hand-editable and never auto-overwritten: the audit `--merge` only adds slugs not already present. The audit report/candidates under `out/` are not committed.
- Worktree off `origin/main`; `npm ci`; copy `.env` before live testing (`PF2E_SYSTEM_PACKS_DIR` is needed for the audit tool).

## Review Focus

- Missing/malformed `creature-environments.json`, or an unknown environment value in old run state → treated as empty map / `None`; behavior equals today's with one console warning.
- A creature unmapped in the map: excluded from strict and adjacent passes, included only after the environment is dropped (never permanently invisible).
- `Random` is seeded: the same run seed → the same environment and the same room picks; a thin environment (few creatures) isn't drawn as often as a rich one.
- Environment relaxation order: with a trait theme AND an environment that together match nothing, the trait theme survives and the environment is dropped first.
- A boss pick, group/twin picks and cap-aware picks (`upwardTolerance: 0`) all carry the environment through; fallback note appears only when a slot actually used `adjacent`/`dropped`.
- Multi-force: a force "same as encounter" inherits; a force's own environment overrides; unsupported-filter warning names `environment` if a custom generator ignores it.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/environments.mjs` (new) | Pure: vocabulary, `ADJACENCY`, `normalizeEnvironment`, `buildEnvironmentLookup`, `environmentsFor`, `creatureFitsEnvironment`, `widenEnvironments`, `pickRandomEnvironment`. |
| `data/creature-environments.json`, `data/creature-environments.sources.json` (new) | Reviewed map + provenance. |
| `tools/audit-creature-environments.mjs` (new) | Seeds the map from pack prose/traits; report + `--merge`. |
| `tools/build-creature-art-pack.mjs` | Export `readPackDirectories` only. |
| `scripts/data-loader.mjs` | `loadCreatureEnvironments()`. |
| `scripts/encounter-roster.mjs` | Environment dimension in `pickCreature`; tally + note; `appliedFilters` gains `environment`. |
| `scripts/encounter-generator.mjs`, `scripts/encounter-forces-dialog.mjs` | Dialog selects, per-force environment, `FILTER_NAMES`, pass-through. |
| `scripts/dungeon-runner.mjs`, `scripts/ui/dungeon-app.mjs`, `templates/dungeon-tracker.hbs`, `scripts/dungeon-scene.mjs` | Run-wide environment (form → run state → rooms). |
| `lang/en.json` | `PF2EDC.Environment.*`. |

---

### Task 1: Environment vocabulary and pure helpers

**Files:**
- Create: `scripts/environments.mjs`
- Test: `tests/environments.test.mjs`

**Interfaces:**
- Produces:
  - `ENVIRONMENTS` (array of the 11 concrete ids, no `any`), `ANY = "any"`.
  - `ADJACENCY` (object: id → ordered array of ids). Table (symmetric closure not required; each list valid ids, no self):
    `forest:[swamp,plains,mountain]`, `swamp:[forest,underwater]`, `cave:[mountain,underground-ruin]`, `desert:[plains,mountain]`, `urban:[plains,underground-ruin]`, `underwater:[swamp,cave]`, `mountain:[cave,arctic,forest]`, `arctic:[mountain,plains]`, `plains:[forest,urban,desert]`, `underground-ruin:[cave,urban]`, `planar:[]`.
  - `normalizeEnvironment(v) → string|null` — returns `v` if it is in `ENVIRONMENTS`, else `null` (so `""`, `"none"`, unknown → `null`).
  - `buildEnvironmentLookup(artList, envMap) → Map<"pack:docId", string[]>` — for each art entry `{id, pack, docId}` with `envMap.creatures[id]` an array of valid ids (filter invalid ids; an empty result is skipped), keyed `${pack}:${docId}`.
  - `environmentsFor(entry, lookup) → string[]|null` (`lookup.get(`${entry.pack}:${entry.id}`) ?? null`; creature entries from `findCreatures` use `{pack, id}` where `id` is the doc id).
  - `creatureFitsEnvironment(entry, environment, lookup) → boolean`: `false` when `lookup` lacks the creature (unmapped); `true` when its list contains `environment` or `any`.
  - `widenEnvironments(environment) → string[][]` = `[[environment], [environment, ...ADJACENCY[environment]]]` (deduped).
  - `pickRandomEnvironment(seed, lookup) → string|null`: weights each concrete environment by the number of lookup creatures listing it (creatures marked `any` don't add weight); environments with weight 0 are excluded; returns `null` if none; deterministic from `seed` via a small string-hash PRNG (no `Math.random`).

- [x] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import { ENVIRONMENTS, ADJACENCY, normalizeEnvironment, buildEnvironmentLookup, environmentsFor,
  creatureFitsEnvironment, widenEnvironments, pickRandomEnvironment } from "../scripts/environments.mjs";

describe("vocabulary", () => {
  it("adjacency lists are valid, non-self, for every environment", () => {
    for (const e of ENVIRONMENTS) {
      expect(ADJACENCY[e], e).toBeDefined();
      for (const a of ADJACENCY[e]) { expect(ENVIRONMENTS).toContain(a); expect(a).not.toBe(e); }
    }
    expect(Object.keys(ADJACENCY).sort()).toEqual([...ENVIRONMENTS].sort());
  });
  it("normalizeEnvironment", () => {
    expect(normalizeEnvironment("swamp")).toBe("swamp");
    for (const bad of ["", "none", "Swamp", "any", null, undefined, 3]) expect(normalizeEnvironment(bad)).toBeNull();
  });
});

const art = [
  { id: "a__gob", pack: "pf2e.x", docId: "D1" },
  { id: "a__frog", pack: "pf2e.x", docId: "D2" },
  { id: "a__zombie", pack: "pf2e.x", docId: "D3" },
  { id: "a__bad", pack: "pf2e.x", docId: "D4" },
];
const map = { version: 1, creatures: { a__gob: ["forest", "cave"], a__frog: ["swamp"], a__zombie: ["any"], a__bad: ["lava", "swamp"] } };
const lookup = buildEnvironmentLookup(art, map);

describe("lookup and fit", () => {
  it("keys by pack:docId, drops invalid ids", () => {
    expect(environmentsFor({ pack: "pf2e.x", id: "D1" }, lookup)).toEqual(["forest", "cave"]);
    expect(environmentsFor({ pack: "pf2e.x", id: "D4" }, lookup)).toEqual(["swamp"]);
    expect(environmentsFor({ pack: "pf2e.x", id: "ZZ" }, lookup)).toBeNull();
  });
  it("fits mapped, any; excludes unmapped", () => {
    expect(creatureFitsEnvironment({ pack: "pf2e.x", id: "D1" }, "cave", lookup)).toBe(true);
    expect(creatureFitsEnvironment({ pack: "pf2e.x", id: "D1" }, "swamp", lookup)).toBe(false);
    expect(creatureFitsEnvironment({ pack: "pf2e.x", id: "D3" }, "desert", lookup)).toBe(true);
    expect(creatureFitsEnvironment({ pack: "pf2e.x", id: "ZZ" }, "desert", lookup)).toBe(false);
  });
  it("tolerates a missing/malformed map", () => {
    expect(buildEnvironmentLookup(art, null).size).toBe(0);
    expect(buildEnvironmentLookup(art, { creatures: "x" }).size).toBe(0);
    expect(buildEnvironmentLookup(null, map).size).toBe(0);
  });
});

describe("widenEnvironments", () => {
  it("strict then adjacent", () => {
    expect(widenEnvironments("swamp")).toEqual([["swamp"], ["swamp", "forest", "underwater"]]);
    expect(widenEnvironments("planar")).toEqual([["planar"], ["planar"]]);
  });
});

describe("pickRandomEnvironment", () => {
  const big = buildEnvironmentLookup(
    [...Array(30).keys()].map((i) => ({ id: `c${i}`, pack: "p", docId: `d${i}` })),
    { creatures: Object.fromEntries([...Array(30).keys()].map((i) => [`c${i}`, [i < 27 ? "forest" : "desert"]])) },
  );
  it("deterministic per seed, only environments with creatures, weighted", () => {
    expect(pickRandomEnvironment("seed-1", big)).toBe(pickRandomEnvironment("seed-1", big));
    const picks = Array.from({ length: 400 }, (_, i) => pickRandomEnvironment(`s${i}`, big));
    expect(new Set(picks)).toEqual(new Set(["forest", "desert"]));
    expect(picks.filter((p) => p === "forest").length).toBeGreaterThan(picks.filter((p) => p === "desert").length * 3);
  });
  it("null when nothing is mapped", () => { expect(pickRandomEnvironment("s", new Map())).toBeNull(); });
});
```

- [x] **Step 2: Run, FAIL** — `npx vitest run tests/environments.test.mjs`.
- [x] **Step 3: Implement** `scripts/environments.mjs` (no imports; for the PRNG hash the seed string with an FNV-1a loop using `>>> 0` and `Math.imul`, then mulberry32; cumulative-weight select).
- [x] **Step 4: Run, PASS. Step 5: Commit** — `git add scripts/environments.mjs tests/environments.test.mjs && git commit -m "#1272: environment vocabulary and pure helpers"`

### Task 2: Selection — environment dimension in `pickCreature`

**Files:**
- Modify: `scripts/encounter-roster.mjs` (`pickCreature` ~154-201, `resolveEncounterRoster` params + both internal `pickCreature` call sites + `pick`/`pickWithinCap` + return value)
- Test: `tests/encounter-roster-environment.test.mjs`; existing `tests/encounter-roster.test.mjs`, `tests/encounter-roster-force-filters.test.mjs` unchanged

**Interfaces:**
- Consumes: `normalizeEnvironment`, `creatureFitsEnvironment`, `widenEnvironments` (Task 1).
- Produces: `resolveEncounterRoster({ ..., environment = null, environmentLookup = null })` and `pickCreature({ ..., environment, environmentLookup })`.
  - `environment` is normalized; when `null` or no `environmentLookup`, the function runs **exactly the existing chain** (golden: identical `findCreatures` call sequence and RNG consumption).
  - When set, define the existing chain as an ordered list of steps `S = [boss-with-traits(if boss), boss-no-traits(if boss), MONSTER_CORE+traits, GENERAL+traits, any+traits, any+no-traits]` (the same order and conditions as today). Environment passes, in order: for `w` in `widenEnvironments(environment)` (strict, then adjacent): run **all** steps in `S` order, each `pool = (await look(...)).filter(e => w.some(env => creatureFitsEnvironment(e, env, lookup)))`; the first non-empty pool wins and records `environmentMatch = index===0 ? "strict" : "adjacent"`. If every step failed in both passes, run the existing chain unfiltered; record `"dropped"` when it yields a creature, else return `null`.
  - Returned entry is `{ ...entry, environmentMatch }` when an environment is active (else the raw entry, unchanged).
  - `resolveEncounterRoster` tallies `environmentMatch` of every **accepted** foe/friend/lurker/twin (local `envTally = { strict, adjacent, dropped }`) and, when `adjacent + dropped > 0`, pushes a warning: `Environment: ${adjacent+dropped} of ${total} creatures from ${dropped ? "outside the chosen" : "adjacent"} environment${…}` — concretely: `adjacent` only → `Environment: N of T creatures from adjacent environments.`; any `dropped` → `Environment: N of T creatures outside the chosen environment (no fitting creatures at this level).` where N counts adjacent+dropped (use the second text if `dropped > 0`).
  - `appliedFilters` becomes `["levelRange","rarity","xpCapOverride","environment"]`.

- [x] **Step 1: Write failing tests** with a stub `api.findCreatures(q)` returning pools from a table keyed by `q.packs`/`q.traits.length` and a lookup built via `buildEnvironmentLookup`:
  - strict hit (creature mapped to the environment) → chosen, `environmentMatch: "strict"`, no note.
  - strict empty, adjacent hit → `"adjacent"` and the adjacent note with right counts.
  - both empty → pass 3 unfiltered → `"dropped"`; `dropped` note text.
  - **Order:** a case with `traits:["undead"]` and `requireTrait:"undead"` where the strict env pool is empty only for the trait steps — assert the first `findCreatures` calls with `traits` set were made before any call with `traits: []`, and that the unfiltered final pass keeps `requireTrait` in every call (assert `q.requireTrait` on all calls).
  - unmapped creature excluded in passes 1-2 and returned in pass 3 (`"dropped"`).
  - `any`-mapped creature matches every environment (strict).
  - `environment: null` and `environment: "bogus"` → the recorded `findCreatures` call list is **deep-equal** to the call list of a run without the new params (golden), and the chosen entry has no `environmentMatch` key; RNG called the same number of times (use a counting `rng`).
  - boss path: `isBoss` first slot uses the boss steps inside each pass.
  - roster-level: a 4-foe roster with 2 adjacent picks yields exactly one note `Environment: 2 of 4 creatures from adjacent environments.`; all-strict yields none; `appliedFilters` includes `"environment"`.
- [x] **Step 2: Run, FAIL. Step 3: Implement** (factor the step list into a local array of thunks so the chain isn't duplicated). **Step 4:** `npx vitest run tests/encounter-roster-environment.test.mjs tests/encounter-roster.test.mjs tests/encounter-roster-force-filters.test.mjs` then `npm test` → PASS.
- [x] **Step 5: Commit** — `git commit -am "#1272: environment-aware creature selection with strict/adjacent/dropped fallback"`

### Task 3: Map data file, loader, schema test

**Files:**
- Create: `data/creature-environments.json` (initially `{ "version": 1, "creatures": {} }`), `data/creature-environments.sources.json` (`{ "version": 1, "sources": {} }`)
- Modify: `scripts/data-loader.mjs` (add `loadCreatureEnvironments()`)
- Test: `tests/creature-environments-data.test.mjs`

**Interfaces:**
- Produces: `loadCreatureEnvironments() → Promise<object>`: fetches `modules/${MODULE_ID}/data/creature-environments.json`; **never rejects** — any failure (404, bad JSON, non-object, no `creatures` object) resolves `{ version: 0, creatures: {} }` with one `console.warn`; successful results cached, failures not cached (mirror `loadRoomFeatureArt`).

- [x] **Step 1: Failing tests:** data-file schema test (reads the JSON from disk): top-level `{version:number, creatures:object}`; every key exists as an `id` in `data/creature-art.json`; every value a non-empty array of unique ids from `ENVIRONMENTS ∪ {"any"}`, with `any` never combined with others; `sources.json` keys ⊆ map keys, values ∈ `"audit"|"manual"`, and every mapped slug has a source. Loader tests (stub global `fetch`): ok, 404, throw, malformed → default object + warn; ok result cached (second call doesn't refetch).
- [x] **Step 2: Run, FAIL. Step 3: Implement. Step 4: Run, PASS. Step 5: Commit** — `git add data tests scripts/data-loader.mjs && git commit -m "#1272: creature-environments data file and loader"`

### Task 4: Audit tool and seeding the map

**Files:**
- Modify: `tools/build-creature-art-pack.mjs` (export `readPackDirectories`; no behavior change)
- Create: `tools/audit-creature-environments.mjs`, `tools/creature-environment-patterns.mjs` (pure extraction), `tests/creature-environment-patterns.test.mjs`
- Modify: `data/creature-environments.json`, `data/creature-environments.sources.json` (via `--merge`, then hand review)
- Modify: `package.json` (`"audit:environments": "node tools/audit-creature-environments.mjs"`)

**Interfaces:**
- Produces (pure, `creature-environment-patterns.mjs`):
  - `extractHabitatText(doc) → string` — concatenates the habitat-bearing prose fields of an extracted actor document (field list fixed by Step 1's probe; default candidates: `system.details.publicNotes`, `system.details.blurb`, `system.details.privateNotes`), HTML tags stripped, whitespace collapsed.
  - `habitatEnvironments(text) → string[]` — finds a habitat sentence via the documented patterns (case-insensitive: `\bhabitat\b[:\s-]*([^.]*)`, `\b(?:lives?|dwells?|found|dwelling|inhabits?)\s+(?:in|among|within|near|throughout)\s+([^.;]*)`) and maps words in the captured clause using `KEYWORDS` (forest/woods/jungle→forest; swamp/marsh/bog/fen→swamp; cave/cavern/underdark→cave; desert/dune/sand→desert; city/town/village/urban/street→urban; ocean/sea/lake/river/underwater/reef→underwater; mountain/peak/crag→mountain; arctic/tundra/glacier/ice/snow→arctic; plain/grassland/farm/prairie→plains; ruin/dungeon/crypt/tomb/temple/catacomb→underground-ruin; plane/planar/abyss/hell/heaven/shadow plane→planar), deduped in vocabulary order.
  - `traitHints(traits) → string[]` — `aquatic|amphibious→underwater`, `plant|fungus→forest`, `swamp→swamp`, `cold|ice→arctic`, `earth→cave`, `fire→desert`, `air→mountain`, `water→underwater`, `fiend|celestial|elemental(extraplanar)|monitor|aeon|archon→planar`, `undead|construct→any`.
  - `candidateFor(doc) → { environments: string[], basis: "prose"|"traits"|"none" }` — prose result wins; else trait hints; if `undead|construct` hint produced `any` only when prose found nothing; else `none` (empty).
- Tool CLI: `node tools/audit-creature-environments.mjs [--probe] [--merge] [--out out/]`. Resolves `PF2E_SYSTEM_PACKS_DIR` (same convention/README note as `packs:build`; abort with a clear message and **write nothing** when unset or missing), reads every pack referenced by `data/creature-art.json` using `readPackDirectories` + the same copy-without-LOCK + `extractPack` recipe into a scratch dir under `os.tmpdir()` (never opens pack dirs in place), and writes only to `out/` (report + `creature-environments-candidates.json`) and, with `--merge`, to `data/`. `--probe` prints which `system.details.*` fields contain `habitat|found in|lives in|dwells` across the first 200 docs per pack, with 5 sample sentences each, and exits (no writes).
  - Report (`out/creature-environments-report.md`): counts mapped/prose/traits-only/unmapped overall and per source pack; 25 random unmapped prose samples; 25 ambiguous (≥3 environments) samples.
  - `--merge`: adds candidates only for art ids not already in `data/creature-environments.json` and skips `environments: []`; records `"audit"` in `.sources.json`; preserves existing entries/sources byte-for-byte (sorted key order on write).

- [ ] **Step 1: Probe (decision input).** Run `PF2E_SYSTEM_PACKS_DIR=… node tools/audit-creature-environments.mjs --probe` after writing the tool skeleton (Step 3 below is done first for the probe path only), pick the prose fields from the output, fix `extractHabitatText`'s field list and note them in the file header. **If no field carries habitat prose for most Monster Core creatures, record that on the issue and rely on `traitHints` + manual curation** — the spec's decision stands (hand-curated map), only the seeding quality changes.
- [ ] **Step 2: Write failing pattern tests** using fixture strings: `"Habitat: swamps and marshes"` → `[swamp]`; `"Goblins live in caves and ruined temples"` → `[cave, underground-ruin]`; `"found in forests near towns"` → `[forest, urban]` (vocabulary order); no habitat sentence → `[]`; HTML-wrapped text; `traitHints(["aquatic"])` → `[underwater]`; `candidateFor` precedence (prose over traits; undead with prose → prose; undead without → `any`); `--merge` logic as a pure function `mergeCandidates(existing, sources, candidates)` never overwrites an existing id and skips empty candidates; assert idempotent (second merge changes nothing).
- [ ] **Step 3: Implement** pure modules, then the CLI. **Step 4:** `npx vitest run tests/creature-environment-patterns.test.mjs` → PASS.
- [ ] **Step 5: Run the audit** (`npm run audit:environments`), read `out/creature-environments-report.md`; iterate `KEYWORDS`/patterns on the unmapped/ambiguous samples until the sample reads sensibly; **post the measured coverage numbers (per source book) as a comment on #1272** (spec requires this).
- [ ] **Step 6:** Run with `--merge`; hand-review at least the Monster Core creatures at levels −1…8 (the likely play range): fix wrong entries directly in `data/creature-environments.json` and change those ids to `"manual"` in `.sources.json`; run `npx vitest run tests/creature-environments-data.test.mjs`.
- [ ] **Step 7: Commit** — `git add tools package.json data tests && git commit -m "#1272: creature environment audit tool and seeded map"` (no `out/` files).

### Task 5: Dungeon run wiring (Start form → run state → rooms)

**Files:**
- Modify: `scripts/dungeon-runner.mjs` (`createRun` param `environment`; state field), `scripts/dungeon-runner.mjs` `startDungeonRun` (resolve `Random`), `scripts/ui/dungeon-app.mjs` (`#onStart` ~1450-1500 reads `[name="environment"]` and passes it to both the GM and relay paths; context ~1055-1075 supplies `environmentOptions`), `templates/dungeon-tracker.hbs` (select near the traits fields ~380), `scripts/dungeon-scene.mjs` (`populateSlotEncounter` ~1236 gains `environment`; the call at ~2095 passes `state.environment`), `scripts/encounter-generator.mjs` (`generateEncounter` gains `environment` param and passes `environment` + `environmentLookup` to the generator call at ~1 site for the single roster path), `lang/en.json`
- Test: `tests/dungeon-environment-run.test.mjs`

**Interfaces:**
- Consumes: Task 1 helpers, Task 3 `loadCreatureEnvironments`, Task 2 params.
- Produces:
  - `createRun({..., environment = null})` stores `environment: normalizeEnvironment(environment)` on run state (`null` = none).
  - `resolveRunEnvironment(choice, seed, lookup) → string|null` exported from `environments.mjs`: `"none"`/empty/unknown → `null`; `"random"` → `pickRandomEnvironment(seed, lookup)`; a vocabulary id → itself. `startDungeonRun({..., environment})` loads art + environments, builds the lookup, and calls it **after** the run seed is known — since `createRun` generates the seed, change `createRun` to accept `environmentChoice` and resolve inside it using an injectable `{ environmentLookup }` option (default: built from `loadCreatureArt()`/`loadCreatureEnvironments()` only when the choice is `"random"`), so the stored value is always final.
  - Start form: `<select name="environment">` with options `random` (default, label `PF2EDC.Environment.Random`), `none` (`PF2EDC.Environment.None`), then each environment (`PF2EDC.Environment.<id>`); label `PF2EDC.Environment.Label`, hint `PF2EDC.Environment.Hint`.
  - `populateSlotEncounter(scene, roomId, { ..., environment = null })` → `generateEncounter({ ..., environment })`; `generateEncounter` loads the lookup once per call (`buildEnvironmentLookup(creatureArt, await loadCreatureEnvironments())`) only when `environment` is non-null.
  - Relay: `dungeon-remote.mjs`'s `startRun` already spreads `args`, so `environment` flows without change — add a test asserting it.

- [ ] **Step 1: Failing tests:** `createRun` stores the normalized choice (`"swamp"`→`swamp`, `"none"`→`null`, `"bogus"`→`null`); `"random"` is deterministic for a given seed and equals `pickRandomEnvironment(seed, lookup)`; `random` with an empty lookup → `null`; `populateSlotEncounter` passes `environment` through (mock `generateEncounter`); `generateEncounter` with `environment: null` calls the generator **without** `environmentLookup` (golden parity) and with `"swamp"` passes both; `dungeon-scene` call site passes `state.environment`; old run state without the field → `undefined` treated as `null`; `startRun` relay forwards `environment`.
- [ ] **Step 2: Run, FAIL. Step 3: Implement** (add lang keys: `Label`, `Hint`, `Random`, `None`, and one label per environment id). **Step 4:** the new test + `npm test` → PASS. **Step 5: Commit** — `git commit -am "#1272: run-wide environment from the Start Dungeon form"`

### Task 6: Stand-alone dialog and multi-force (#1083)

**Files:**
- Modify: `scripts/encounter-forces-dialog.mjs` (encounter-level `environment` select in `chooseEncounterForces`, `filters.environment` on each force: `defaultForce`, `normalizeForce`, `forceSectionHtml`, `readForcesFromForm`, labels), `scripts/encounter-generator.mjs` (`FILTER_NAMES` gains `["environment", (f) => !!f.environment]`; `generateForces` passes `environment: fl.environment || chosen.environment || null` and the lookup; single-force path passes `chosen.environment`), `lang/en.json`
- Test: `tests/encounter-forces-dialog.test.mjs` (extend), `tests/encounter-generator-forces.test.mjs` (extend)

**Interfaces:**
- Produces: `chooseEncounterForces` result gains `environment: string|null` (default `None`; normalized); each `force.filters.environment: string` where `""` means "same as encounter" (normalized to `""` or a vocabulary id).

- [ ] **Step 1: Failing tests:** `defaultForce(...).filters.environment === ""`; `normalizeForce` coerces unknown to `""`; `forceSectionHtml` includes `name="force-<id>-environment"` with the selected option and a "same as encounter" first option; `readForcesFromForm` reads it; generation: force with `""` inherits `chosen.environment`, force with `"cave"` overrides, both reach the generator call as `environment`; encounter `None` + force `""` → `null` (no lookup passed); a generator stub whose roster lacks `"environment"` in `appliedFilters` while a force requested one → warning `ForceFilterUnsupported` with `name: "environment"`.
- [ ] **Step 2: Run, FAIL. Step 3: Implement. Step 4:** both test files + `npm test` → PASS. **Step 5: Commit** — `git commit -am "#1272: environment in the stand-alone and multi-force dialogs"`

### Task 7: Docs, version, live verification

- [ ] **Step 1:** README: Environment section (what it does, the map file, `npm run audit:environments`, `PF2E_SYSTEM_PACKS_DIR`, "hand edits are never overwritten"). Run the `update-architecture-docs` skill and commit its output. Bump `module.json`; `npm test` + `npm run validate:dungeon` → PASS; commit.
- [ ] **Step 2: Live verification** (copy `.env`; compare the live world's module version with the branch): (a) Start Dungeon with Swamp → combat rooms' creatures are swamp-appropriate (check against the map) or the chat card notes adjacent/outside fallbacks; (b) Start with Random twice on the same seed value → same environment (read `getRunState(sceneId).environment`); (c) stand-alone Generate Encounter with Underwater; (d) a two-force encounter with different environments and one "same as encounter"; (e) `None` is unchanged (compare roster shape/behavior with a pre-change run); (f) rename the data file temporarily → warning in console, encounters still generate.
- [ ] **Step 3:** Open the PR; after merge label `verification` (live playtest pending), remove `claimed`/`in progress`, merge with explicit `--subject/--body`.

## Self-Review

Spec coverage: vocabulary/adjacency/`any`/fit/widen (T1), strict→adjacent→dropped with environment-before-traits order and note (T2), map file + schema test + never-reject loader (T3), audit tool with probe, patterns, trait hints, report, coverage posted to the issue, `--merge` never overwriting, sources file (T4), Start form + seeded Random + run state + room inheritance + relay (T5), stand-alone dialog + per-force override/inherit + `FILTER_NAMES` (T6), localization (T5/T6), docs/live verification (T7). Planning-left questions resolved: `Random` is weighted by mapped-creature count (T1), adjacency table fixed in T1, habitat fields decided by the T4 probe with a documented fallback. Names consistent: `normalizeEnvironment`, `buildEnvironmentLookup`, `creatureFitsEnvironment`, `widenEnvironments`, `pickRandomEnvironment`, `resolveRunEnvironment`, `environmentLookup`, `environmentMatch`, `loadCreatureEnvironments`.
