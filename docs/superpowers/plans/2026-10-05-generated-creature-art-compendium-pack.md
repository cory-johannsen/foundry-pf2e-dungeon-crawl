# Generated Creature-Art Compendium Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a real, browsable Foundry compendium pack (`generated-creature-art`) containing one Actor per `data/creature-art.json` entry with its generated art baked on, built by a new, re-runnable script.

**Architecture:** A new orchestrator function, `buildCreatureArtPack()`, in `tools/build-creature-art-pack.mjs` groups `data/creature-art.json`'s 5,904 entries by source `pack`, uses `@foundryvtt/foundryvtt-cli`'s `extractPack` to pull each source pack's full Actor JSON from the local pf2e system install (configurable path, `PF2E_SYSTEM_PACKS_DIR`), overrides each matched document's art fields, writes one JSON file per actor into `packs/generated-creature-art/_source/`, then `compilePack`s that into the real LevelDB pack Foundry reads at runtime. `module.json` registers the new pack; `CLAUDE.md` gets a new rule requiring every `data/creature-art.json`-touching PR to rebuild and commit it.

**Tech Stack:** `@foundryvtt/foundryvtt-cli@3.0.4` (new devDependency) for LevelDB pack extraction/compilation, Vitest for the build script's own test, Node's `fs`/`path`/`os` for fixtures and scratch directories.

**Spec:** `docs/superpowers/specs/2026-10-05-generated-creature-art-compendium-pack-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). Architecture-level change (new pack-building subsystem): minor bump. Current version at plan-writing time is `0.58.4` — re-check immediately before committing, since concurrent sessions push to this repo.
- `PF2E_SYSTEM_PACKS_DIR` defaults to `/srv/foundry/data/Data/systems/pf2e/packs` (this host's confirmed real layout) but must be overridable via `process.env.PF2E_SYSTEM_PACKS_DIR` — no `dotenv` dependency, matching this repo's existing convention (`tools/agent-service/validate-decision-model.mjs` reads `process.env` directly).
- `extractPack`'s own real file-naming convention (confirmed by reading `@foundryvtt/foundryvtt-cli@3.0.4`'s source) is `${getSafeFilename(doc.name)}_${doc._id}.json`, never a predictable `<id>.json` — every extracted-pack lookup in this plan joins by parsing each file's own `_id` field, never by constructing a filename from an id.
- Each new pack actor's own `_id` reuses its `data/creature-art.json` entry's `docId` unchanged (pack-scoped ids, no collision risk, keeps the join key this codebase already uses everywhere else).
- `tools/.pack-build-scratch/` (intermediate `extractPack` output, regenerated every run) must never be committed.
- `packs/generated-creature-art/_source/*.json` and the compiled `packs/generated-creature-art/` LevelDB output ARE committed to git — this module ships via a raw branch-zip download with no separate release-build step.

## Review Focus

- **A creature-art entry whose `pack` has no matching source directory on disk must fail loudly, not silently skip.** `PF2E_SYSTEM_PACKS_DIR` misconfiguration or a renamed/missing system pack would otherwise produce a quietly-incomplete compendium. Covered by Task 1's "missing source pack directory" test.
- **A creature-art entry whose `docId` isn't found in its extracted source pack must fail loudly, not silently skip.** A stale `docId` (source actor renamed/removed upstream) is exactly the kind of drift this feature exists to prevent going unnoticed. Covered by Task 1's "docId not found in extracted pack" test.
- **The art-override must replace, not merge onto, any existing `prototypeToken.texture.src`** — a source actor's own prototype token data must not leak through partially. Covered by Task 1's override assertion checking the full resulting value, not just that the key changed.
- **Re-running the build must be idempotent** — `tools/.pack-build-scratch/` from a prior run must not leave stale extracted files that get matched against the wrong creature-art entry on a second run. Covered by Task 1's "scratch directory is cleared before each pack's extraction" step and test.
- **The CLAUDE.md rule must actually name the exact command and exact paths to commit**, not just "keep it in sync" — a vague rule is not enforceable by a future agent. Covered by Task 3's exact rule text.

---

### Task 1: `buildCreatureArtPack` orchestrator with a fully offline fixture test

**Files:**
- Create: `tools/build-creature-art-pack.mjs`
- Test: `tests/build-creature-art-pack.test.mjs`

**Interfaces:**
- Produces: `export async function buildCreatureArtPack({ creatureArtPath, systemPacksDir, scratchDir, sourceOutDir, packOutDir, log = false })` — returns nothing; throws on any entry it can't resolve. Consumed by Task 2 (the real CLI invocation) and Task 4 (the real build run).

Exporting this one async orchestrator function is a deliberate, narrow departure from this repo's usual `tools/*.mjs` style (e.g. `tools/migrate-creature-art-sources.mjs` exports nothing and is tested as a pure black box) — there's nothing to black-box test here without it, since the real work is several async calls into `@foundryvtt/foundryvtt-cli` against directories that must be fixture-controlled per test run.

- [ ] **Step 1: Write the failing test**

Create `tests/build-creature-art-pack.test.mjs`:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { buildCreatureArtPack } from "../tools/build-creature-art-pack.mjs";

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf2edc-pack-build-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Builds a tiny real LevelDB pack at `${root}/system-packs/<packName>/`
 * from plain document objects, mirroring the real pf2e system's own pack
 * layout closely enough for extractPack to read it back. */
async function buildFixtureSystemPack(packName, docs) {
  const srcDir = join(root, "system-packs-source", packName);
  mkdirSync(srcDir, { recursive: true });
  for (const doc of docs) {
    writeFileSync(join(srcDir, `${doc._id}.json`), JSON.stringify(doc));
  }
  const destDir = join(root, "system-packs", packName);
  await compilePack(srcDir, destDir, { log: false });
  return destDir;
}

describe("buildCreatureArtPack", () => {
  it("extracts matched source actors, overrides art, and compiles a real LevelDB pack", async () => {
    await buildFixtureSystemPack("fixture-pack-one", [
      {
        _id: "aaaaaaaaaaaaaaaa",
        name: "Fixture Goblin",
        type: "npc",
        img: "icons/svg/mystery-man.svg",
        prototypeToken: { texture: { src: "icons/svg/mystery-man.svg" } },
      },
    ]);
    await buildFixtureSystemPack("fixture-pack-two", [
      {
        _id: "bbbbbbbbbbbbbbbb",
        name: "Fixture Skeleton",
        type: "npc",
        img: "icons/svg/mystery-man.svg",
        prototypeToken: { texture: { src: "icons/svg/mystery-man.svg" } },
      },
    ]);

    const creatureArtPath = join(root, "creature-art.json");
    writeFileSync(
      creatureArtPath,
      JSON.stringify([
        {
          id: "fixture_pack_one__fixture_goblin",
          pack: "pf2e.fixture-pack-one",
          docId: "aaaaaaaaaaaaaaaa",
          name: "Fixture Goblin",
          level: 0,
          art: "fixture-pack-one/fixture-goblin.webp",
        },
        {
          id: "fixture_pack_two__fixture_skeleton",
          pack: "pf2e.fixture-pack-two",
          docId: "bbbbbbbbbbbbbbbb",
          name: "Fixture Skeleton",
          level: 1,
          art: "fixture-pack-two/fixture-skeleton.webp",
        },
      ]),
    );

    const sourceOutDir = join(root, "out", "_source");
    const packOutDir = join(root, "out", "pack");

    await buildCreatureArtPack({
      creatureArtPath,
      systemPacksDir: join(root, "system-packs"),
      scratchDir: join(root, "scratch"),
      sourceOutDir,
      packOutDir,
      log: false,
    });

    const goblin = JSON.parse(
      readFileSync(join(sourceOutDir, "aaaaaaaaaaaaaaaa.json"), "utf8"),
    );
    expect(goblin._id).toBe("aaaaaaaaaaaaaaaa");
    expect(goblin.name).toBe("Fixture Goblin");
    expect(goblin.img).toBe(
      "modules/pf2e-dungeon-crawl/assets/creature-art/fixture-pack-one/fixture-goblin.webp",
    );
    expect(goblin.prototypeToken.texture.src).toBe(
      "modules/pf2e-dungeon-crawl/assets/creature-art/fixture-pack-one/fixture-goblin.webp",
    );

    const skeleton = JSON.parse(
      readFileSync(join(sourceOutDir, "bbbbbbbbbbbbbbbb.json"), "utf8"),
    );
    expect(skeleton.img).toBe(
      "modules/pf2e-dungeon-crawl/assets/creature-art/fixture-pack-two/fixture-skeleton.webp",
    );

    // compilePack really ran and produced a real LevelDB pack.
    expect(existsSync(join(packOutDir, "CURRENT"))).toBe(true);
  });

  it("throws when a creature-art entry's pack has no matching source directory", async () => {
    const creatureArtPath = join(root, "creature-art.json");
    writeFileSync(
      creatureArtPath,
      JSON.stringify([
        {
          id: "missing_pack__entry",
          pack: "pf2e.does-not-exist",
          docId: "cccccccccccccccc",
          name: "Ghost Entry",
          level: 0,
          art: "does-not-exist/ghost-entry.webp",
        },
      ]),
    );

    await expect(
      buildCreatureArtPack({
        creatureArtPath,
        systemPacksDir: join(root, "system-packs"),
        scratchDir: join(root, "scratch"),
        sourceOutDir: join(root, "out", "_source"),
        packOutDir: join(root, "out", "pack"),
        log: false,
      }),
    ).rejects.toThrow(/does-not-exist/);
  });

  it("throws when a creature-art entry's docId isn't found in its extracted source pack", async () => {
    await buildFixtureSystemPack("fixture-pack-three", [
      {
        _id: "dddddddddddddddd",
        name: "Unrelated Fixture",
        type: "npc",
        img: "icons/svg/mystery-man.svg",
      },
    ]);

    const creatureArtPath = join(root, "creature-art.json");
    writeFileSync(
      creatureArtPath,
      JSON.stringify([
        {
          id: "fixture_pack_three__missing_doc",
          pack: "pf2e.fixture-pack-three",
          docId: "eeeeeeeeeeeeeeee",
          name: "Missing Doc",
          level: 0,
          art: "fixture-pack-three/missing-doc.webp",
        },
      ]),
    );

    await expect(
      buildCreatureArtPack({
        creatureArtPath,
        systemPacksDir: join(root, "system-packs"),
        scratchDir: join(root, "scratch"),
        sourceOutDir: join(root, "out", "_source"),
        packOutDir: join(root, "out", "pack"),
        log: false,
      }),
    ).rejects.toThrow(/eeeeeeeeeeeeeeee/);
  });

  it("clears the scratch directory before each pack's extraction, so a stale prior run never leaks in", async () => {
    await buildFixtureSystemPack("fixture-pack-four", [
      {
        _id: "ffffffffffffffff",
        name: "Fixture Wolf",
        type: "npc",
        img: "icons/svg/mystery-man.svg",
      },
    ]);

    const creatureArtPath = join(root, "creature-art.json");
    writeFileSync(
      creatureArtPath,
      JSON.stringify([
        {
          id: "fixture_pack_four__fixture_wolf",
          pack: "pf2e.fixture-pack-four",
          docId: "ffffffffffffffff",
          name: "Fixture Wolf",
          level: 0,
          art: "fixture-pack-four/fixture-wolf.webp",
        },
      ]),
    );

    const scratchDir = join(root, "scratch");
    // Plant a stale leftover file from an imagined prior run, inside the
    // exact per-pack scratch subdirectory this build is about to use.
    mkdirSync(join(scratchDir, "fixture-pack-four"), { recursive: true });
    writeFileSync(
      join(scratchDir, "fixture-pack-four", "Stale Leftover_zzzzzzzzzzzzzzzz.json"),
      JSON.stringify({ _id: "zzzzzzzzzzzzzzzz", name: "Stale Leftover" }),
    );

    const sourceOutDir = join(root, "out", "_source");
    await buildCreatureArtPack({
      creatureArtPath,
      systemPacksDir: join(root, "system-packs"),
      scratchDir,
      sourceOutDir,
      packOutDir: join(root, "out", "pack"),
      log: false,
    });

    // The stale file must be gone from the scratch dir after the clear,
    // and never produced a matching _source output of its own.
    expect(
      existsSync(join(scratchDir, "fixture-pack-four", "Stale Leftover_zzzzzzzzzzzzzzzz.json")),
    ).toBe(false);
    expect(existsSync(join(sourceOutDir, "zzzzzzzzzzzzzzzz.json"))).toBe(false);
    expect(existsSync(join(sourceOutDir, "ffffffffffffffff.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/build-creature-art-pack.test.mjs`
Expected: FAIL — `Cannot find module '../tools/build-creature-art-pack.mjs'` (and `Cannot find package '@foundryvtt/foundryvtt-cli'` until Step 3's dependency install).

- [ ] **Step 3: Install the new dependency**

```bash
npm install --save-dev @foundryvtt/foundryvtt-cli@^3.0.4
```

- [ ] **Step 4: Write `tools/build-creature-art-pack.mjs`**

```js
/**
 * Builds the `generated-creature-art` compendium pack (#599) from
 * data/creature-art.json: reads each referenced source pack's full Actor
 * documents off the local pf2e system install, overrides img/
 * prototypeToken.texture.src with the generated art path, and compiles
 * the result into a real LevelDB pack this module ships directly.
 *
 * Reads source data via extractPack against a local filesystem path
 * rather than the foundry-rest relay this codebase otherwise always uses
 * to read compendium data -- a deliberate choice (see
 * docs/superpowers/specs/2026-10-05-generated-creature-art-compendium-pack-design.md)
 * since this build is required on every PR that touches
 * data/creature-art.json and can't depend on a live Foundry world being
 * open for every one of those.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compilePack, extractPack } from "@foundryvtt/foundryvtt-cli";

const MODULE_ID = "pf2e-dungeon-crawl";

export async function buildCreatureArtPack({
  creatureArtPath,
  systemPacksDir,
  scratchDir,
  sourceOutDir,
  packOutDir,
  log = false,
}) {
  const entries = JSON.parse(readFileSync(creatureArtPath, "utf8"));
  const entriesByPack = new Map();
  for (const entry of entries) {
    const list = entriesByPack.get(entry.pack) ?? [];
    list.push(entry);
    entriesByPack.set(entry.pack, list);
  }

  mkdirSync(sourceOutDir, { recursive: true });

  for (const [pack, packEntries] of entriesByPack) {
    const packName = pack.replace(/^pf2e\./, "");
    const srcDir = join(systemPacksDir, packName);
    const packScratchDir = join(scratchDir, packName);

    // #599 Review Focus: idempotent re-runs -- never let a prior run's
    // extracted files leak into this one.
    rmSync(packScratchDir, { recursive: true, force: true });
    mkdirSync(packScratchDir, { recursive: true });

    try {
      await extractPack(srcDir, packScratchDir, { log });
    } catch (e) {
      throw new Error(
        `Failed to extract source pack "${pack}" from ${srcDir}: ${e.message}`,
      );
    }

    const docsById = new Map();
    for (const file of readdirSync(packScratchDir)) {
      if (!file.endsWith(".json")) continue;
      const doc = JSON.parse(readFileSync(join(packScratchDir, file), "utf8"));
      docsById.set(doc._id, doc);
    }

    for (const entry of packEntries) {
      const source = docsById.get(entry.docId);
      if (!source) {
        throw new Error(
          `docId "${entry.docId}" (${entry.name}) not found in extracted pack "${pack}" ` +
            `(${docsById.size} documents extracted from ${srcDir})`,
        );
      }
      const artPath = `modules/${MODULE_ID}/assets/creature-art/${entry.art}`;
      const overridden = {
        ...source,
        img: artPath,
        prototypeToken: {
          ...(source.prototypeToken ?? {}),
          texture: { ...(source.prototypeToken?.texture ?? {}), src: artPath },
        },
      };
      writeFileSync(
        join(sourceOutDir, `${entry.docId}.json`),
        JSON.stringify(overridden),
      );
      if (log) console.log(`${entry.pack} :: ${entry.name} (${entry.docId})`);
    }
  }

  await compilePack(sourceOutDir, packOutDir, { log });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const ROOT = new URL("..", import.meta.url).pathname;
  await buildCreatureArtPack({
    creatureArtPath: join(ROOT, "data", "creature-art.json"),
    systemPacksDir:
      process.env.PF2E_SYSTEM_PACKS_DIR ?? "/srv/foundry/data/Data/systems/pf2e/packs",
    scratchDir: join(ROOT, "tools", ".pack-build-scratch"),
    sourceOutDir: join(ROOT, "packs", "generated-creature-art", "_source"),
    packOutDir: join(ROOT, "packs", "generated-creature-art"),
    log: true,
  });
  console.log("Done.");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/build-creature-art-pack.test.mjs`
Expected: PASS, all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add tools/build-creature-art-pack.mjs tests/build-creature-art-pack.test.mjs package.json package-lock.json
git commit -m "feat(#599): add buildCreatureArtPack orchestrator with fixture tests

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire up `package.json`, `.gitignore`, and `module.json`

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `module.json`

**Interfaces:**
- Consumes: `tools/build-creature-art-pack.mjs`'s CLI entry point from Task 1.
- Produces: `npm run packs:build`, the registered `generated-creature-art` pack — consumed by Task 4 (the real build) and by Foundry itself at runtime.

- [ ] **Step 1: Add the npm script**

In `package.json`, add to `"scripts"` (alongside the existing `"art:normalize"`/`"validate:creature-art"` entries):

```json
    "packs:build": "node tools/build-creature-art-pack.mjs",
```

(The `"@foundryvtt/foundryvtt-cli"` devDependency was already added by Task 1's `npm install`.)

- [ ] **Step 2: Ignore the scratch directory**

Add to `.gitignore`:

```
tools/.pack-build-scratch/
```

- [ ] **Step 3: Register the pack in `module.json`**

Change `"packs": []` to:

```json
  "packs": [
    {
      "name": "generated-creature-art",
      "label": "Generated Creature Art",
      "path": "packs/generated-creature-art",
      "type": "Actor",
      "system": "pf2e",
      "ownership": { "PLAYER": "LIMITED", "ASSISTANT": "OWNER" }
    }
  ],
```

- [ ] **Step 4: Confirm the JSON is still valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('module.json', 'utf8')); JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('valid')"`
Expected: prints `valid` with no error.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore module.json
git commit -m "feat(#599): register generated-creature-art pack and packs:build script

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Add the CLAUDE.md sync-enforcement rule

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** None — documentation-only change, read by every future agent session working in this repo.

- [ ] **Step 1: Add the new rule**

In `CLAUDE.md`, directly after the existing `## Versioning` section's last bullet (the "Run the `update-architecture-docs` skill..." item), add a new subsection:

```markdown

## Generated creature-art compendium pack

Any PR that changes `data/creature-art.json` must also run `npm run
packs:build` and commit the resulting `packs/generated-creature-art/`
(both its compiled LevelDB files and its `_source/*.json`) in the same
PR. The compendium pack is a derived artifact of `data/creature-art.json`
and must never be allowed to drift out of sync with it, the same way
`module.json`'s version must never be left un-bumped after a merge.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(#599): require packs:build on every creature-art.json-touching PR

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Run the real build and ship the pack

**Files:**
- Create: `packs/generated-creature-art/_source/*.json` (5,904 files)
- Create: `packs/generated-creature-art/` (the compiled LevelDB pack)

**Interfaces:**
- Consumes: `buildCreatureArtPack` (Task 1), the real `data/creature-art.json` (5,904 entries), the real `/srv/foundry/data/Data/systems/pf2e/packs` on this host.
- Produces: the actual shipped pack — nothing further consumes this within this plan.

This is the one task that can't be a fixture/synthetic run — it's the real build, against real data, producing what actually ships. Budget real wall-clock time: 44 source-pack extractions plus 5,904 document writes plus one `compilePack` run. `log: true` (already wired into the CLI entry point in Task 1) prints progress for both phases.

- [ ] **Step 1: Confirm the local pf2e system packs path is present**

```bash
ls "${PF2E_SYSTEM_PACKS_DIR:-/srv/foundry/data/Data/systems/pf2e/packs}" | head -5
```

Expected: lists real pack directory names (e.g. `pathfinder-monster-core`). If this is empty or the path doesn't exist, set `PF2E_SYSTEM_PACKS_DIR` to the correct path for the machine running this step before continuing.

- [ ] **Step 2: Run the real build**

```bash
npm run packs:build
```

Expected: runs to completion printing one `extractPack`/entry log line per source pack and creature, ending with `Done.` and no thrown error. If it throws `docId "..." not found in extracted pack "..."` or `Failed to extract source pack...`, that is a real data-integrity finding (a stale `data/creature-art.json` entry or a missing/renamed system pack) — investigate and resolve it rather than suppressing the error, since this is exactly the drift this feature exists to catch.

- [ ] **Step 3: Verify the output**

```bash
ls packs/generated-creature-art/_source/ | wc -l
ls packs/generated-creature-art/
```

Expected: the first command prints `5904` (one `_source/*.json` file per `data/creature-art.json` entry); the second lists real LevelDB files (`CURRENT`, `LOCK`, `LOG`, `MANIFEST-*`, one or more `*.ldb` files).

- [ ] **Step 4: Bump `module.json`'s version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (architecture-level change — new compendium pack subsystem), e.g. `0.58.4` → `0.59.0`, using whatever the fetch above shows as current.

- [ ] **Step 5: Commit**

```bash
git add packs/generated-creature-art module.json
git commit -m "feat(#599): build and ship the generated-creature-art compendium pack

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:** The spec's four concrete deliverables — build script, `module.json` registration, `.env`/path configurability, and the CLAUDE.md enforcement rule — map onto Task 1 (script), Task 2 (registration + script wiring + gitignore), Task 2's env-var-as-plain-`process.env`-read (already in Task 1's code, no separate task needed since it's a one-line default), and Task 3 (rule). Task 4 covers the spec's implicit fifth deliverable: the actual shipped pack, not just the tooling to build one. No gaps found.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling" steps, no "similar to Task N" — every step has real, runnable code or an exact command.

**3. Type consistency:** `buildCreatureArtPack({creatureArtPath, systemPacksDir, scratchDir, sourceOutDir, packOutDir, log})` is defined once in Task 1 and invoked with the identical parameter names in Task 1's own test fixtures and Task 1's own CLI entry point (which Task 4 runs via `npm run packs:build`). The `generated-creature-art` pack name is identical across the spec, Task 2's `module.json` entry, Task 1's CLI entry point's `packOutDir`, and Task 3's CLAUDE.md text.

**4. Review Focus:** All five items (missing source pack directory, missing docId, full art-override replacement, scratch-directory idempotency, an enforceable exact-command CLAUDE.md rule) each have a dedicated test or explicit step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-generated-creature-art-compendium-pack.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Subagent-driven**, because Task 4 commits 5,904 real generated files as the module's actual shipped content and depends entirely on Task 1's orchestrator being correct first — an independent reviewer catching a subtle bug in Task 1 (e.g. a wrong art-path join, or a doc overwritten incompletely) before Task 4 bakes it into 5,904 real files is worth more here than the cost of a fresh context per task. Does the plan capture what you want, and which approach should we use?
