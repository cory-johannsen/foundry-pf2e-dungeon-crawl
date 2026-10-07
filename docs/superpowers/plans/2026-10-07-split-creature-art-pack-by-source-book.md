# Split Creature-Art Pack By Source Book Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #744 — the single compiled `generated-creature-art` LevelDB pack (64.4 MB at 5,928 entries today, confirmed this session) will exceed GitHub's 100 MB hard limit at roughly 9,600 entries. Split the compiled output into one small pack per source book instead.

**Recommendation already reached this session (recorded on the issue, re-stated here as the plan's own grounding):** Of the issue's own four listed options — (1) tune LevelDB table-file size, (2) split by source book, (3) Git LFS, (4) publish as a release asset instead of a committed file — split-by-source-book wins:
- **Git LFS is a confirmed non-starter**, not a guess: this module's own `module.json` distributes via `"download": ".../archive/refs/heads/main.zip"` (a raw branch download). GitHub's auto-generated branch zips never resolve LFS pointers — a real install would get empty pointer files instead of art.
- **The release-asset option is pricier than it sounds:** there is no `.github/workflows/` at all today. It would mean building a CI release pipeline, changing `module.json`'s own `download` field away from the raw-branch-zip pattern, and taking on ongoing release-tagging discipline this project doesn't have.
- **LevelDB table-size tuning is the least certain option.** `classic-level`'s own default `maxFileSize` is 2 MB, yet the real compiled output is one 61+ MB file — `compilePack` isn't respecting that default as-is, and it's unverified whether the knob is even exposed through the CLI wrapper this build script uses, or whether a smaller table size would actually dedupe across rebuilds. It also doesn't solve the problem, just defers the same ceiling further out.
- **Split-by-source-book uses data that already exists in exactly this shape.** Every entry in `data/creature-art.json` already carries a `pack` field, and `buildCreatureArtPack` already groups entries by it internally (`entriesByPack`, confirmed current, `tools/build-creature-art-pack.mjs:85-90`) to extract the right source documents — this plan extends that existing grouping to also compile one output pack per group, rather than inventing new logic. Measured this session: 58 distinct source packs, largest (`pathfinder-monster-core`) has 483 entries — at today's ~10.4 KB/actor, that's ~5 MB, two orders of magnitude under the ceiling, with a margin that holds as the bestiary grows by *adding* new books rather than ballooning existing ones. It also fixes the secondary git-bloat complaint for free: a rebuild only rewrites the one book's own pack, not all 64 MB.

**Confirmed this session: nothing in the module's own runtime code queries the compiled pack by name at all** (`grep -rn "generated-creature-art" scripts/*.mjs` returns nothing) — it exists purely so a GM can browse the compendium in Foundry's UI and see the generated art (#599's own stated purpose); creature spawning overlays the art path directly onto a freshly-created actor, never reading the compiled pack. This means splitting the compiled output has **no runtime consumer to update** — only the build tooling, `module.json`'s own pack declarations, and documentation.

**Architecture:** `data/creature-art.json`'s own source docs keep writing into one shared, flat, git-committed `packs/generated-creature-art/_source/*.json` directory, exactly as today — `check-creature-art-pack.mjs`'s own staleness check (confirmed current, reads this directory flatly via `readdirSync`) needs **zero changes**. Only the *compiled* output changes shape: instead of one `compilePack(sourceOutDir, packOutDir)` call compiling the whole flat directory, `buildCreatureArtPack` compiles one small LevelDB pack per source book into `packs/generated-creature-art/<bookSlug>/`, from a temporary per-book scratch copy of just that book's own already-written source docs. A new `regenerateModuleJsonPacks` helper then rewrites `module.json`'s own `packs` array to list all 58 (and however many future) book packs automatically, so nobody hand-maintains that list.

**Tech Stack:** Node.js, `@foundryvtt/foundryvtt-cli`, Vitest.

**Spec:** None — bounded; the recommendation, the data shape, and the absence of any runtime consumer are all confirmed this session, not guessed.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real structural change to the shipped pack plus a real rebuild: minor bump — matching CLAUDE.md's own existing rule that a pack rebuild is committed "before a minor version bump" anyway.
- `packs/generated-creature-art/_source/*.json`'s own flat layout, and `check-creature-art-pack.mjs`'s own reading of it, are **unchanged** — confirmed this session that nothing about the split requires touching the staleness-check mechanism at all.
- `assertSafeOutputDirs`'s own existing safety checks and its one real caller's own directory relationship (`packOutDir` containing `sourceOutDir` as a subdirectory) are **unchanged** — the split only adds per-book subdirectories *alongside* `_source/` under the same `packOutDir`, the identical shape the function already guards today.
- Every one of the 58 (and any future) per-book packs uses the **exact same ownership config** the single pack uses today (`{PLAYER: "LIMITED", ASSISTANT: "OWNER"}`) — no per-book variation.
- A book's own human-readable `label` in `module.json` comes from the **real pf2e system's own `system.json` label for that pack** (confirmed accessible: `readPackDirectories`, confirmed current, already reads `system.packs`) — never an invented or slug-derived name, so the compendium sidebar reads naturally (e.g. "Generated Creature Art — Monster Core", not "Generated Creature Art — pathfinder-monster-core").
- The actual rebuild (Task 4) needs a local pf2e system install (`PF2E_SYSTEM_PACKS_DIR`, per the README's own existing requirement) — this is real, not simulated; if no such install is available at implementation time, Task 4 is the one step that must wait for one rather than being faked.

## Review Focus

- **Every one of the 58 current source books must compile into its own pack, with every entry accounted for** — none silently dropped, none duplicated across two book packs.
- **A book removed from `creature-art.json` entirely (zero remaining entries) must have its own old compiled pack directory deleted**, not left behind as stale dead weight — mirroring the existing single-pack build's own stale-doc cleanup, now scoped per-book.
- **`module.json`'s own regenerated `packs` array must preserve every other top-level field untouched** (`id`, `version`, `title`, `relationships`, etc.) — a regeneration step that clobbers unrelated manifest fields would be a much worse bug than the one being fixed.
- **The shared `_source/*.json` directory and `check-creature-art-pack.mjs`'s own behavior must be provably unaffected** — a regression test, not an assumption, since this is the one piece explicitly designed to stay untouched.
- **The real, rebuilt output must actually fit comfortably under GitHub's limits** — Task 4 checks the real file sizes after a real rebuild, not just the measured-today estimate.

---

### Task 1: Per-book compile split in `buildCreatureArtPack`

**Files:**
- Modify: `tools/build-creature-art-pack.mjs`
- Test: `tests/build-creature-art-pack.test.mjs`

**Interfaces:**
- Produces: `buildCreatureArtPack(...)` now returns `{ actors, droppedItems, books: [{ pack, slug, label }] }` (adds `books`, the list this task's own module.json-regeneration step, Task 2, consumes) — `actors`/`droppedItems` keep their existing meaning and shape.

- [ ] **Step 1: Update the existing tests for the new output shape**

The existing fixture helper `fixturePack` (confirmed current, `tests/build-creature-art-pack.test.mjs:47-54`) declares `{name, path}` in `system.json`; extend it to also declare `label` (e.g. `declared.push({ name, path: \`packs/${dir}\`, label: name })`), since Task 1's own code reads it.

Every existing test that currently asserts against a single compiled pack at `paths.packOutDir` directly (e.g. `existsSync(join(paths.packOutDir, "CURRENT"))`, confirmed current line 138; `extractPack(paths.packOutDir, back, ...)`, lines 140/188/255/293) now needs to target a **per-book subdirectory** instead — e.g. for a fixture using source pack `"alpha"` (`pf2e.alpha`), the compiled output lands at `join(paths.packOutDir, "alpha")`, not `paths.packOutDir` itself. Update each of this file's own ~14 test cases to read from the right per-book subdirectory for whichever book(s) that test's own fixture entries declare, following this one concrete example:

```js
it("builds across two packs: overrides art, derives ids/keys, sets flags, compiles a readable LevelDB", async () => {
  // ... existing fixturePack/entry/run setup, unchanged ...
  const result = await buildCreatureArtPack(paths);
  expect(result.books).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ pack: "pf2e.alpha", slug: "alpha" }),
      expect.objectContaining({ pack: "pf2e.beta", slug: "beta" }),
    ]),
  );
  expect(existsSync(join(paths.packOutDir, "alpha", "CURRENT"))).toBe(true);
  expect(existsSync(join(paths.packOutDir, "beta", "CURRENT"))).toBe(true);
  const back = join(root, "roundtrip-alpha");
  await extractPack(join(paths.packOutDir, "alpha"), back, { log: false });
  // ... existing per-doc assertions, now scoped to the one book's own extracted docs ...
});
```

Apply the same "read from `packOutDir/<slug>/` instead of `packOutDir/` directly" conversion to every remaining test in this file whose fixture declares a single book — most of them use one source pack named `"src"` or similar; confirm the exact slug each test's own fixture produces (`pack.replace(/^pf2e\./, "")`) before updating its own assertions.

Add two new tests for the behavior this task actually introduces:

```js
it("compiles one small pack per source book, not one combined pack", async () => {
  await fixturePack("alpha", "alpha-dir", [actor("a1", "Alpha One")]);
  await fixturePack("beta", "beta-dir", [actor("b1", "Beta One")]);
  const result = await run([
    entry("alpha", "a1", "Alpha One", "alpha.webp"),
    entry("beta", "b1", "Beta One", "beta.webp"),
  ]);
  expect(readdirSync(result.paths.packOutDir).sort()).toEqual(["_source", "alpha", "beta"]);
});

it("removes a book's own compiled pack when it no longer has any entries", async () => {
  await fixturePack("alpha", "alpha-dir", [actor("a1", "Alpha One")]);
  const paths = makePaths([entry("alpha", "a1", "Alpha One", "alpha.webp")]);
  await buildCreatureArtPack(paths);
  expect(existsSync(join(paths.packOutDir, "alpha"))).toBe(true);
  writeFileSync(paths.creatureArtPath, JSON.stringify([])); // alpha has no entries anymore
  await buildCreatureArtPack(paths);
  expect(existsSync(join(paths.packOutDir, "alpha"))).toBe(false);
  expect(existsSync(join(paths.packOutDir, "_source"))).toBe(true); // never touched
});
```

(Adjust `makePaths`/`run`'s own exact helper signature to match whatever this file's own real helpers are named after Step 1's own fixture update.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/build-creature-art-pack.test.mjs`
Expected: FAIL — the build still compiles one combined pack at `packOutDir` directly.

- [ ] **Step 3: Implement the per-book split**

Change `readPackDirectories` (confirmed current, `tools/build-creature-art-pack.mjs:35-42`):

```js
function readPackDirectories(systemPacksDir) {
  const systemJsonPath = join(systemPacksDir, "..", "system.json");
  if (!existsSync(systemJsonPath)) {
    throw new Error(`system.json not found at ${systemJsonPath}; cannot resolve pack directories`);
  }
  const system = JSON.parse(readFileSync(systemJsonPath, "utf8"));
  return new Map((system.packs ?? []).map((p) => [p.name, p.path]));
}
```

to:

```js
function readPackDirectories(systemPacksDir) {
  const systemJsonPath = join(systemPacksDir, "..", "system.json");
  if (!existsSync(systemJsonPath)) {
    throw new Error(`system.json not found at ${systemJsonPath}; cannot resolve pack directories`);
  }
  const system = JSON.parse(readFileSync(systemJsonPath, "utf8"));
  return new Map((system.packs ?? []).map((p) => [p.name, { path: p.path, label: p.label ?? p.name }]));
}
```

Update this function's own two callers inside `buildCreatureArtPack` (confirmed current, lines 100/104: `dirOf.get(packName)` used as a path string directly) to destructure `{path: relDir, label}` instead of treating the map's value as a bare path string.

In `buildCreatureArtPack`, after the existing per-book loop that writes every doc into `sourceOutDir` (confirmed current, lines 98-179) — track each book's own derived ids as they're created (add a `const idsByPack = new Map()` alongside `usedIds`, pushing each `newId` onto `idsByPack.get(pack) ?? []` the same place `usedIds.add(newId)` already happens, line 141) — then replace the single closing compile step (confirmed current, lines 183-191):

```js
  // packOutDir may contain sourceOutDir (the shipped layout); clear only the
  // previously compiled LevelDB files, never the freshly written _source.
  if (existsSync(packOutDir)) {
    for (const name of readdirSync(packOutDir)) {
      if (resolve(packOutDir, name) === sourceOutDir) continue;
      rmSync(join(packOutDir, name), { recursive: true, force: true });
    }
  }
  await compilePack(sourceOutDir, packOutDir, { log });
  return { actors: usedIds.size, droppedItems };
}
```

with:

```js
  // #744: one small compiled pack per source book, not one combined pack
  // nearing GitHub's 100 MB file limit. _source stays flat and shared
  // (check-creature-art-pack.mjs's own staleness check reads it directly,
  // unaffected by this split).
  const books = [];
  const currentSlugs = new Set();
  for (const pack of entriesByPack.keys()) {
    const packName = pack.replace(/^pf2e\./, "");
    currentSlugs.add(packName);
  }
  // Remove every book's own compiled pack that no longer has any entries
  // (the whole-directory stale cleanup, now scoped per book rather than
  // wiping everything but _source).
  if (existsSync(packOutDir)) {
    for (const name of readdirSync(packOutDir)) {
      const full = resolve(packOutDir, name);
      if (full === sourceOutDir) continue;
      if (currentSlugs.has(name)) continue;
      rmSync(full, { recursive: true, force: true });
    }
  }
  for (const [pack, packEntries] of entriesByPack) {
    const packName = pack.replace(/^pf2e\./, "");
    const label = dirOf.get(packName)?.label ?? packName;
    const bookCompileDir = join(scratchDir, "compile", packName);
    rmSync(bookCompileDir, { recursive: true, force: true });
    mkdirSync(bookCompileDir, { recursive: true });
    for (const newId of idsByPack.get(pack) ?? []) {
      cpSync(join(sourceOutDir, `${newId}.json`), join(bookCompileDir, `${newId}.json`));
    }
    const bookPackOutDir = join(packOutDir, packName);
    rmSync(bookPackOutDir, { recursive: true, force: true });
    await compilePack(bookCompileDir, bookPackOutDir, { log });
    books.push({ pack, slug: packName, label });
    if (log) console.log(`${pack}: compiled ${packEntries.length} actors -> ${bookPackOutDir}`);
  }
  return { actors: usedIds.size, droppedItems, books };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/build-creature-art-pack.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run `check-creature-art-pack`'s own tests to confirm it's genuinely unaffected**

Run: `npx vitest run tests/check-creature-art-pack.test.mjs`
Expected: PASS, unmodified — this is the regression check for the Global Constraint that this file needs zero changes.

- [ ] **Step 6: Commit**

```bash
git add tools/build-creature-art-pack.mjs tests/build-creature-art-pack.test.mjs
git commit -m "feat(#744): compile one small creature-art pack per source book

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Auto-regenerate `module.json`'s own `packs` array

**Files:**
- Modify: `tools/build-creature-art-pack.mjs`
- Test: `tests/build-creature-art-pack.test.mjs` (or a new `tests/regenerate-module-json-packs.test.mjs`, if this file is getting large — check its own current line count first)

**Interfaces:**
- Produces: `regenerateModuleJsonPacks(moduleJsonPath, books)` — `books` is the `{pack, slug, label}[]` Task 1's own `buildCreatureArtPack` now returns.

- [ ] **Step 1: Write the failing tests**

```js
import { regenerateModuleJsonPacks } from "../tools/build-creature-art-pack.mjs";

describe("regenerateModuleJsonPacks", () => {
  it("replaces only the packs array, preserving every other top-level field", () => {
    const path = join(root, "module.json");
    writeFileSync(path, JSON.stringify({
      id: "pf2e-dungeon-crawl", version: "1.2.3", title: "Dungeon Crawl",
      packs: [{ name: "old-single-pack", label: "Old", path: "packs/old", type: "Actor", system: "pf2e", ownership: { PLAYER: "LIMITED", ASSISTANT: "OWNER" } }],
      relationships: { systems: [{ id: "pf2e", type: "system", compatibility: { minimum: "6.0.0" } }] },
    }, null, 2));
    regenerateModuleJsonPacks(path, [
      { pack: "pf2e.alpha", slug: "alpha", label: "Alpha Book" },
      { pack: "pf2e.beta", slug: "beta", label: "Beta Book" },
    ]);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    expect(manifest.id).toBe("pf2e-dungeon-crawl");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.relationships).toEqual({ systems: [{ id: "pf2e", type: "system", compatibility: { minimum: "6.0.0" } }] });
    expect(manifest.packs).toEqual([
      {
        name: "generated-creature-art-alpha", label: "Generated Creature Art — Alpha Book",
        path: "packs/generated-creature-art/alpha", type: "Actor", system: "pf2e",
        ownership: { PLAYER: "LIMITED", ASSISTANT: "OWNER" },
      },
      {
        name: "generated-creature-art-beta", label: "Generated Creature Art — Beta Book",
        path: "packs/generated-creature-art/beta", type: "Actor", system: "pf2e",
        ownership: { PLAYER: "LIMITED", ASSISTANT: "OWNER" },
      },
    ]);
  });

  it("sorts books by slug, for a stable diff across rebuilds", () => {
    const path = join(root, "module.json");
    writeFileSync(path, JSON.stringify({ packs: [] }));
    regenerateModuleJsonPacks(path, [
      { pack: "pf2e.zeta", slug: "zeta", label: "Zeta" },
      { pack: "pf2e.alpha", slug: "alpha", label: "Alpha" },
    ]);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    expect(manifest.packs.map((p) => p.slug ?? p.name)).toEqual(["generated-creature-art-alpha", "generated-creature-art-zeta"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/build-creature-art-pack.test.mjs`
Expected: FAIL — `regenerateModuleJsonPacks` does not exist yet.

- [ ] **Step 3: Implement `regenerateModuleJsonPacks`**

Add to `tools/build-creature-art-pack.mjs`:

```js
/**
 * #744: rewrites moduleJsonPath's own `packs` array to list one entry per
 * source book, from `books` (buildCreatureArtPack's own return value) --
 * nobody hand-maintains this list; it's regenerated every build. Every
 * other top-level manifest field is read back and written out unchanged.
 */
export function regenerateModuleJsonPacks(moduleJsonPath, books) {
  const manifest = JSON.parse(readFileSync(moduleJsonPath, "utf8"));
  const sorted = [...books].sort((a, b) => a.slug.localeCompare(b.slug));
  manifest.packs = sorted.map(({ slug, label }) => ({
    name: `generated-creature-art-${slug}`,
    label: `Generated Creature Art — ${label}`,
    path: `packs/generated-creature-art/${slug}`,
    type: "Actor",
    system: "pf2e",
    ownership: { PLAYER: "LIMITED", ASSISTANT: "OWNER" },
  }));
  writeFileSync(moduleJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/build-creature-art-pack.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/build-creature-art-pack.mjs tests/build-creature-art-pack.test.mjs
git commit -m "feat(#744): regenerate module.json's own packs array from the books a build produces

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire regeneration into the CLI entry point; update docs

**Files:**
- Modify: `tools/build-creature-art-pack.mjs` (CLI entry point)
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Call the new regeneration step from the CLI entry point**

Change (confirmed current, `tools/build-creature-art-pack.mjs:195-207`):

```js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ROOT = new URL("..", import.meta.url).pathname;
  const { actors, droppedItems } = await buildCreatureArtPack({
    creatureArtPath: join(ROOT, "data", "creature-art.json"),
    systemPacksDir:
      process.env.PF2E_SYSTEM_PACKS_DIR ?? "/srv/foundry/data/Data/systems/pf2e/packs",
    scratchDir: join(ROOT, "tools", ".pack-build-scratch"),
    sourceOutDir: join(ROOT, "packs", "generated-creature-art", "_source"),
    packOutDir: join(ROOT, "packs", "generated-creature-art"),
    log: false,
  });
  console.log(`Done. ${actors} actors, ${droppedItems} duplicate embedded items dropped.`);
}
```

to:

```js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ROOT = new URL("..", import.meta.url).pathname;
  const { actors, droppedItems, books } = await buildCreatureArtPack({
    creatureArtPath: join(ROOT, "data", "creature-art.json"),
    systemPacksDir:
      process.env.PF2E_SYSTEM_PACKS_DIR ?? "/srv/foundry/data/Data/systems/pf2e/packs",
    scratchDir: join(ROOT, "tools", ".pack-build-scratch"),
    sourceOutDir: join(ROOT, "packs", "generated-creature-art", "_source"),
    packOutDir: join(ROOT, "packs", "generated-creature-art"),
    log: false,
  });
  regenerateModuleJsonPacks(join(ROOT, "module.json"), books);
  console.log(`Done. ${actors} actors, ${droppedItems} duplicate embedded items dropped, ${books.length} book packs.`);
}
```

- [ ] **Step 2: Update `README.md`**

Change (confirmed current, `README.md:85-103`) to describe the per-book layout:

```markdown
### Compendium pack

`packs/generated-creature-art/` holds one shipped Actor compendium per
source book (e.g. "Generated Creature Art — Monster Core"), each holding
one copy of each pf2e creature from that book in `data/creature-art.json`
with its generated art applied — split by book (#744) so no single
compiled file approaches GitHub's 100 MB limit as the art catalog grows.
It is derived data: never edit it by hand. `module.json`'s own `packs`
array is regenerated by every build, one entry per book -- never
hand-maintained.

```bash
npm run packs:build    # rebuild; needs a local pf2e install
npm run packs:check    # offline staleness report (add -- --strict to exit 1 if stale)
```

`packs:build` reads the pf2e system packs from `PF2E_SYSTEM_PACKS_DIR`
(default `/srv/foundry/data/Data/systems/pf2e/packs`); it copies them first
and never modifies the install. Rebuild and commit the result when an art
batch finishes or before a minor version bump, not on every PR. The shared
`packs/generated-creature-art/_source/*.json` files are unchanged across
rebuilds (git dedupes them); each book's own compiled pack is rewritten
completely, but only for books whose own entries actually changed.
```

- [ ] **Step 3: Update `CLAUDE.md`**

Update the "Generated creature-art compendium pack" section (confirmed current, top of file) to match the README's own new wording — the derived-artifact warning and the rebuild-cadence rule both stay, only the "single LevelDB pack" framing changes to "one pack per source book."

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/build-creature-art-pack.mjs README.md CLAUDE.md
git commit -m "docs(#744): describe the per-source-book creature-art pack layout

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Real rebuild, old pack cleanup, and commit

This is the actual migration — needs a local pf2e system install (`PF2E_SYSTEM_PACKS_DIR`), per the README's own existing requirement. Not simulated.

- [ ] **Step 1: Run the real rebuild**

```bash
npm run packs:build
```

Expected: `packs/generated-creature-art/_source/` unchanged in content (same docs, just possibly reordered on disk); 58 new subdirectories (`packs/generated-creature-art/<slug>/`), each a small compiled LevelDB pack; the OLD single-pack `.ldb`/`LOG`/`CURRENT`/`MANIFEST` files sitting directly in `packs/generated-creature-art/` (not inside a book subdirectory) are gone, removed by this same build run's own cleanup logic (Task 1's per-book stale-removal, since the old flat layout has no `currentSlugs.has(name)` match).

- [ ] **Step 2: Verify real file sizes**

```bash
du -sh packs/generated-creature-art/*/ | sort -rh | head -5
```

Expected: the largest book pack is in the low single-digit megabytes, confirming this session's own ~5 MB estimate for the largest book (`pathfinder-monster-core`).

- [ ] **Step 3: Verify `module.json`'s own regenerated packs array**

```bash
grep -c '"name": "generated-creature-art-' module.json
```

Expected: 58 (or however many distinct source books `data/creature-art.json` currently has — re-check with `python3 -c "import json; print(len(set(e['pack'] for e in json.load(open('data/creature-art.json')))))"` if this plan's own count has drifted since this session).

- [ ] **Step 4: Run `packs:check` to confirm the shared `_source` staleness check still passes cleanly**

```bash
npm run packs:check
```

Expected: "Pack is up to date." — confirming the Global Constraint that this check is genuinely unaffected by the split.

- [ ] **Step 5: Stage and commit the real rebuild**

```bash
git add packs/generated-creature-art/ module.json
git status --short  # confirm the old flat .ldb files show as deleted, not just the new subdirectories as added
git commit -m "chore(#744): rebuild creature-art pack split by source book (#744)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real structural change to the shipped pack, matching CLAUDE.md's own existing "commit a pack rebuild before a minor version bump" rule), using whatever the fetch above shows as current. Note: Task 4's own rebuild already wrote `module.json`'s own `packs` array — this step only touches `version`, in the same file, same commit as Task 4's own if convenient, or its own follow-up commit.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#744): bump version for the split creature-art pack

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #744's own ask (don't exceed GitHub's 100 MB limit as the catalog grows, and stop rewriting 61 MB on every rebuild) is covered by the per-book split (Task 1), with the previously-manual `module.json` pack list now auto-regenerated (Task 2) so adding a 59th book in the future needs no manual module.json editing at all, and a real rebuild (Task 4) confirms the real numbers rather than trusting the estimate.

**2. Placeholder scan:** No TBD. Every number (58 books, 483-entry largest book, ~5 MB estimate, the confirmed absence of any runtime consumer) was measured or grepped this session, not assumed.

**3. Type consistency:** `buildCreatureArtPack`'s own new `books` return field feeds `regenerateModuleJsonPacks` directly, same shape (`{pack, slug, label}`) at both ends — no translation layer invented between them.

**4. Review Focus:** All five items (every book's entries fully accounted for, a removed book's own stale pack cleaned up, module.json's other fields preserved, `_source`/`check-creature-art-pack` provably unaffected, real post-rebuild file sizes checked) each map to a specific task or test. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-07-split-creature-art-pack-by-source-book.md`.
