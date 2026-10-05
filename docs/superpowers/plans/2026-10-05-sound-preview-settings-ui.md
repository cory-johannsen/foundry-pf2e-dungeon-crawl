# Sound Preview Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the GM a settings-menu form listing every dungeon-crawl sound effect with a play button per row, so sounds can be auditioned without triggering the real game event each one is tied to.

**Architecture:** A new `ApplicationV2`/`HandlebarsApplicationMixin` class (`SoundPreviewApp`), opened via a standard `game.settings.registerMenu` entry, mirroring the exact class/template/action-handler shape `scripts/ui/dungeon-app.mjs`'s existing `DungeonApp` already establishes in this codebase. A new pure function in `scripts/dungeon-sound.mjs` builds the list of previewable sounds (key, humanized label, resolved path) that the new app's `_prepareContext()` hands to its template.

**Tech Stack:** Vanilla ES modules, Foundry VTT's `ApplicationV2`/`HandlebarsApplicationMixin` API (confirmed live on this world's Foundry v14.368), Handlebars templates, Vitest for the new pure-function's unit tests, the `foundry-rest` skill for live UI verification.

**Spec:** None — bounded feature addition, no architectural change. This plan implements GitHub issue #600 directly.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` field (CLAUDE.md). This is a routine addition: patch bump. Current version at plan-writing time is `0.57.14` — re-check immediately before committing, since concurrent sessions push to this repo.
- Mirror `scripts/ui/dungeon-app.mjs`'s `DungeonApp` conventions exactly: `static DEFAULT_OPTIONS`/`static PARTS`/`async _prepareContext()` shape, `static async #onX(event, target)` private action-handler methods reading `target.dataset`, `MODULE_ID = "pf2e-dungeon-crawl"` and `const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;` at the top of the new file. Do not invent a different UI pattern.
- `playSound()` (`scripts/audio.mjs`) defaults to `broadcast: true`; every preview call must explicitly pass `{ broadcast: false }` so auditioning a sound as GM never plays it for every connected player.
- `styles/dungeon.css` is the ONLY stylesheet this module registers (`module.json`'s `styles` array) — add a new section to that file; do not create a second stylesheet or touch `module.json`'s `styles` array.
- No per-sound localization entries — label each of the 16 rows via a derived, humanized string from its own catalog key (`doorOpen` → "Door Open"), not 16 individual `lang/en.json` keys.

## Review Focus

- **A sound file that's missing from disk must be caught by a test, not discovered by a GM clicking a dead button.** `scripts/dungeon-sound.mjs`'s existing `DUNGEON_SOUND_FILES` catalog is already covered by an `existsSync` test in `tests/dungeon-sound.test.mjs`, but the two spell-outcome sounds (`SPELL_HIT_SOUND`/`SPELL_MISS_SOUND`) aren't part of that catalog and need their own coverage once they're part of the previewable list. Covered by Task 1's new `soundPreviewEntries()` existence test.
- **The preview list must include every catalog sound, not silently drop one if `DUNGEON_SOUND_FILES` grows.** A hardcoded array of 14 names in the new preview function would silently stop covering a 15th sound added later. Covered by deriving `soundPreviewEntries()` from `Object.keys(DUNGEON_SOUND_FILES)` directly, plus a test asserting the returned list's length always equals `Object.keys(DUNGEON_SOUND_FILES).length + 2`.
- **A preview click must never broadcast to players.** The one behavioral requirement in the issue beyond "list and play" — easy to get backwards since `playSound`'s own default is the opposite. Covered by Task 2's explicit `{ broadcast: false }` call and documented in its own docblock.
- **The settings form must be GM-only, matching "GM-facing" in the issue title.** `registerMenu`'s `restricted: true` flag is Foundry's standard mechanism for this — omitting it would expose the menu entry to every player. Covered by Task 3's exact registration call and its live-verification step.
- **Each row's play button must target the exact spell/catalog sound it's labeled as, not a stale or mismatched path.** With 16 rows built by one loop, an indexing or key-matching slip could wire the wrong button to the wrong path. Covered by Task 4's live verification step, which reads back all 16 `{label, path}` pairs from a real render and checks each resolved path against the catalog it was derived from.

---

### Task 1: Add `soundPreviewEntries()` with full unit coverage

**Files:**
- Modify: `scripts/dungeon-sound.mjs:49-52` (export `SPELL_HIT_SOUND`, `SPELL_MISS_SOUND`, `soundPath`; add `soundPreviewEntries()` and private `humanizeSoundKey()`)
- Test: `tests/dungeon-sound.test.mjs` (add a new `describe` block; add `soundPreviewEntries` to the existing import list)

**Interfaces:**
- Consumes: the existing `DUNGEON_SOUND_FILES` object and `SOUND_DIR` const already in this file.
- Produces: `export function soundPreviewEntries(): Array<{key: string, label: string, path: string}>` — consumed by Task 2.

- [x] **Step 1: Write the failing tests**

Open `tests/dungeon-sound.test.mjs`. Add `soundPreviewEntries` to the existing import at the top of the file:

```js
import {
  DUNGEON_SOUND_FILES,
  strikeHitSoundKey,
  strikeSoundPath,
  spellSaveSoundPath,
  spellAttackSoundPath,
  soundPreviewEntries,
} from "../scripts/dungeon-sound.mjs";
```

Add this new `describe` block at the end of the file:

```js
describe("soundPreviewEntries", () => {
  const SOUND_DIR = "modules/pf2e-dungeon-crawl/assets/sounds";

  it("returns one row per DUNGEON_SOUND_FILES key plus the two spell-outcome sounds", () => {
    expect(soundPreviewEntries()).toHaveLength(
      Object.keys(DUNGEON_SOUND_FILES).length + 2,
    );
  });

  it("every row's path resolves to a file that actually exists on disk", () => {
    for (const { path } of soundPreviewEntries()) {
      expect(existsSync(path.replace(SOUND_DIR, assetsDir.replace(/\/$/, "")))).toBe(
        true,
      );
    }
  });

  it("humanizes a camelCase catalog key into a spaced, capitalized label", () => {
    const row = soundPreviewEntries().find((r) => r.key === "strikeHitBludgeoning");
    expect(row.label).toBe("Strike Hit Bludgeoning");
  });

  it("resolves a catalog key's row to the same path strikeSoundPath-style resolution would give", () => {
    const row = soundPreviewEntries().find((r) => r.key === "doorOpen");
    expect(row.path).toBe(`${SOUND_DIR}/door-open.ogg`);
  });

  it("includes the two spell-outcome sounds with their own keys and real card-sound paths", () => {
    const entries = soundPreviewEntries();
    expect(entries.find((r) => r.key === "spellHit")).toEqual({
      key: "spellHit",
      label: "Spell Hit",
      path: `${SOUND_DIR}/card-arcane.ogg`,
    });
    expect(entries.find((r) => r.key === "spellMiss")).toEqual({
      key: "spellMiss",
      label: "Spell Miss",
      path: `${SOUND_DIR}/card-query.ogg`,
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dungeon-sound.test.mjs -t soundPreviewEntries`
Expected: every new test FAILs with `soundPreviewEntries is not a function` (or an import error), since the function doesn't exist yet.

- [x] **Step 3: Implement `soundPreviewEntries` and export its dependencies**

In `scripts/dungeon-sound.mjs`, change lines 49-52 from:

```js
const SPELL_HIT_SOUND = `${SOUND_DIR}/card-arcane.ogg`;
const SPELL_MISS_SOUND = `${SOUND_DIR}/card-query.ogg`;

function soundPath(key) {
```

to:

```js
export const SPELL_HIT_SOUND = `${SOUND_DIR}/card-arcane.ogg`;
export const SPELL_MISS_SOUND = `${SOUND_DIR}/card-query.ogg`;

export function soundPath(key) {
```

Then, directly after `soundPath`'s closing `}` (immediately before the `/** Ranged weapon groups...` docblock that currently follows it), insert:

```js
/** One row per previewable sound (#600) -- every DUNGEON_SOUND_FILES key
 * plus the two spell-outcome sounds that reuse card assets, each resolved
 * to its real playable path and a humanized label derived from its own
 * camelCase key (no per-sound localization entry -- 16 one-off lang keys
 * for an internal GM preview list isn't worth the upkeep). Derived from
 * DUNGEON_SOUND_FILES directly (not a separate hardcoded list) so a sound
 * added to the catalog later is automatically previewable too. */
export function soundPreviewEntries() {
  const fromCatalog = Object.keys(DUNGEON_SOUND_FILES).map((key) => ({
    key,
    label: humanizeSoundKey(key),
    path: soundPath(key),
  }));
  return [
    ...fromCatalog,
    { key: "spellHit", label: "Spell Hit", path: SPELL_HIT_SOUND },
    { key: "spellMiss", label: "Spell Miss", path: SPELL_MISS_SOUND },
  ];
}

function humanizeSoundKey(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dungeon-sound.test.mjs -t soundPreviewEntries`
Expected: PASS, all 5 new tests green.

- [x] **Step 5: Run the full test file to confirm no regression**

Run: `npx vitest run tests/dungeon-sound.test.mjs`
Expected: PASS, every existing test (including the `existsSync`-per-catalog-key block and `strikeHitSoundKey`/`spellSaveSoundPath`/`spellAttackSoundPath` blocks) still green.

- [x] **Step 6: Commit**

```bash
git add scripts/dungeon-sound.mjs tests/dungeon-sound.test.mjs
git commit -m "feat(#600): add soundPreviewEntries for a GM sound-preview list

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `SoundPreviewApp` (ApplicationV2 class) and its template

**Files:**
- Create: `scripts/ui/sound-preview-app.mjs`
- Create: `templates/sound-preview.hbs`

**Interfaces:**
- Consumes: `soundPreviewEntries()` (Task 1) from `../dungeon-sound.mjs`; `playSound(src, {volume, broadcast})` (already exported, unmodified) from `../audio.mjs`.
- Produces: `export class SoundPreviewApp extends HandlebarsApplicationMixin(ApplicationV2)` — consumed by Task 3's `registerMenu` call.

- [x] **Step 1: Create the template**

Create `templates/sound-preview.hbs`:

```handlebars
<section class="pf2edc-sound-preview">
  <ul class="pf2edc-sound-preview__list">
    {{#each sounds}}
      <li class="pf2edc-sound-preview__row">
        <span class="pf2edc-sound-preview__label">{{this.label}}</span>
        <button type="button" data-action="play" data-sound-path="{{this.path}}">{{localize
            "PF2EDC.SoundPreview.PlayButtonLabel"
          }}</button>
      </li>
    {{/each}}
  </ul>
</section>
```

- [x] **Step 2: Create the application class**

Create `scripts/ui/sound-preview-app.mjs`:

```js
import { soundPreviewEntries } from "../dungeon-sound.mjs";
import { playSound } from "../audio.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** GM-facing settings-menu form (#600) listing every dungeon-crawl sound
 * effect with a play button, so a GM can audition them without triggering
 * the real game event each one is tied to. Mirrors DungeonApp's own
 * ApplicationV2/HandlebarsApplicationMixin shape (scripts/ui/dungeon-app.mjs)
 * -- the established pattern for this module's custom UI. */
export class SoundPreviewApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "pf2edc-sound-preview-app",
    tag: "section",
    window: { title: "PF2EDC.SoundPreview.Title", icon: "fa-solid fa-volume-high" },
    position: { width: 360, height: "auto" },
    actions: {
      play: SoundPreviewApp.#onPlay,
    },
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/sound-preview.hbs` },
  };

  async _prepareContext() {
    return { sounds: soundPreviewEntries() };
  }

  /** #600: broadcast:false so auditioning a sound as GM doesn't also play
   * it for every connected player -- playSound's own default is
   * broadcast:true, meant for real in-play triggers, not previewing. */
  static #onPlay(event, target) {
    const path = target?.dataset?.soundPath;
    if (!path) return;
    playSound(path, { broadcast: false });
  }
}
```

- [x] **Step 3: Commit**

```bash
git add scripts/ui/sound-preview-app.mjs templates/sound-preview.hbs
git commit -m "feat(#600): add SoundPreviewApp settings-menu form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

(No automated test in this task — see this plan's Self-Review and Task 4: `SoundPreviewApp` is UI glue wrapping live Foundry globals exactly as `DungeonApp` already does, and `DungeonApp` itself has no unit test file in this codebase. Task 4 verifies this class live instead.)

---

### Task 3: Register the settings menu and localization strings

**Files:**
- Modify: `scripts/module.mjs:1-6` (import), `scripts/module.mjs:116-124` (registration, inside the existing `Hooks.once("init", ...)` block)
- Modify: `lang/en.json:173-174` (new keys)
- Modify: `styles/dungeon.css` (new section, appended at end of file)

**Interfaces:**
- Consumes: `SoundPreviewApp` from Task 2.
- Produces: a working, GM-restricted entry in Foundry's own Settings UI — consumed (verified) by Task 4.

- [x] **Step 1: Add the import and registration to `scripts/module.mjs`**

Change the top import block (lines 2-6) from:

```js
import {
  DungeonApp,
  resolveCurrentRoom,
  retreatFromCard,
} from "./ui/dungeon-app.mjs";
```

to:

```js
import {
  DungeonApp,
  resolveCurrentRoom,
  retreatFromCard,
} from "./ui/dungeon-app.mjs";
import { SoundPreviewApp } from "./ui/sound-preview-app.mjs";
```

Then, inside the existing `Hooks.once("init", () => { ... });` block, change the end from:

```js
  game.settings.register(MODULE_ID, "actionPaceDelayMs", {
    name: "PF2EDC.Settings.ActionPaceDelayMs.Name",
    hint: "PF2EDC.Settings.ActionPaceDelayMs.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0, max: 5000, step: 100 },
    default: 1200,
  });
});
```

to:

```js
  game.settings.register(MODULE_ID, "actionPaceDelayMs", {
    name: "PF2EDC.Settings.ActionPaceDelayMs.Name",
    hint: "PF2EDC.Settings.ActionPaceDelayMs.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0, max: 5000, step: 100 },
    default: 1200,
  });
  // #600: lets a GM audition every dungeon-crawl sound effect without
  // triggering the real game event each one is tied to.
  game.settings.registerMenu(MODULE_ID, "soundPreview", {
    name: "PF2EDC.SoundPreview.Title",
    label: "PF2EDC.Settings.SoundPreview.Label",
    hint: "PF2EDC.Settings.SoundPreview.Hint",
    icon: "fa-solid fa-volume-high",
    type: SoundPreviewApp,
    restricted: true,
  });
});
```

- [x] **Step 2: Add the new keys to `lang/en.json`**

Change the file's last two lines (173-174) from:

```json
  "PF2EDC.Settings.MovementStepDelayMs.Name": "AI combat: pause between movement steps (ms)"
}
```

to:

```json
  "PF2EDC.Settings.MovementStepDelayMs.Name": "AI combat: pause between movement steps (ms)",
  "PF2EDC.Settings.SoundPreview.Hint": "Audition this module's sound effects without triggering the game event each one is tied to.",
  "PF2EDC.Settings.SoundPreview.Label": "Open Sound Preview",
  "PF2EDC.SoundPreview.PlayButtonLabel": "Play",
  "PF2EDC.SoundPreview.Title": "Sound Preview"
}
```

- [x] **Step 3: Add the stylesheet section**

Append to the end of `styles/dungeon.css`:

```css

/* ----- Sound preview (GM settings menu) ----- */
.pf2edc-sound-preview__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.pf2edc-sound-preview__row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.pf2edc-sound-preview__label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [x] **Step 4: Confirm the JSON is still valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('lang/en.json', 'utf8')); console.log('valid')"`
Expected: prints `valid` with no error.

- [x] **Step 5: Commit**

```bash
git add scripts/module.mjs lang/en.json styles/dungeon.css
git commit -m "feat(#600): register the sound-preview settings menu

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Live-verify the full settings UI against a real Foundry world

**Files:** none (verification only, via the `foundry-rest` skill — no files change in this task).

**Interfaces:**
- Consumes: the fully wired `SoundPreviewApp` and `registerMenu` entry from Tasks 2-3.
- Produces: nothing consumed by a later task — this is the plan's final verification step.

This task has no "write a failing test" step: it verifies a live Foundry `ApplicationV2` render pipeline, the same kind of UI glue this codebase has already chosen to verify live rather than unit-test (`DungeonApp` itself, which this new class mirrors, has no unit test file).

- [ ] **Step 1: Write and save the verification script**

Save this to the session scratchpad (not the repo) as `verify-sound-preview-app.js`:

```js
// Live end-to-end verification of #600: confirm the registered menu entry
// exists with the right class and restricted flag, then actually render
// SoundPreviewApp and check its real _prepareContext() output -- all 16
// rows present, each with a label and a path that matches the catalog it
// was derived from.
const MODULE_ID = "pf2e-dungeon-crawl";

const menuEntry = game.settings.menus.get(`${MODULE_ID}.soundPreview`);
const menuCheck = {
  found: !!menuEntry,
  restricted: menuEntry?.restricted ?? null,
  typeName: menuEntry?.type?.name ?? null,
};

const app = new menuEntry.type();
await app.render(true);

const context = await app._prepareContext();
const rowCheck = {
  count: context.sounds.length,
  sampleRow: context.sounds.find((r) => r.key === "doorOpen"),
  allHaveLabelAndPath: context.sounds.every((r) => !!r.label && !!r.path),
  uniqueKeys: new Set(context.sounds.map((r) => r.key)).size,
};

app.close();

return { menuCheck, rowCheck };
```

- [ ] **Step 2: Run it**

Run: `.claude/skills/foundry-rest/foundry-exec.sh verify-sound-preview-app.js` (from the repo root).

Expected result shape:

```json
{
  "menuCheck": { "found": true, "restricted": true, "typeName": "SoundPreviewApp" },
  "rowCheck": {
    "count": 16,
    "sampleRow": { "key": "doorOpen", "label": "Door Open", "path": "modules/pf2e-dungeon-crawl/assets/sounds/door-open.ogg" },
    "allHaveLabelAndPath": true,
    "uniqueKeys": 16
  }
}
```

If `menuCheck.found` is `false`, the module build served to the live world is stale (re-deploy/reload and retry — see `reference_foundry_module_deploy_race` precedent) rather than a code bug. If `rowCheck.count` isn't 16 or `uniqueKeys` isn't 16, re-check Task 1's `soundPreviewEntries()` against the current `DUNGEON_SOUND_FILES` catalog before assuming Task 2/3's wiring is at fault.

- [ ] **Step 3: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a patch bump (e.g. `0.57.14` → `0.57.15`, using whatever the fetch above shows as current) in `module.json`.

- [ ] **Step 4: Commit**

```bash
git add module.json
git commit -m "chore: bump version for #600 sound-preview settings UI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** Issue #600's Scope section names two things: (a) a `registerMenu` entry pointing at a custom form — Task 3; (b) the form lists every `DUNGEON_SOUND_FILES` key plus the two spell sounds, each with a label and play button calling `playSound(path, {broadcast:false})` — Task 1 (list-building) + Task 2 (form + play handler). Both covered.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling" steps, no "similar to Task N" hand-waving — every step has real, runnable code, an exact diff, or an exact shell command.

**3. Type consistency:** `soundPreviewEntries(): Array<{key, label, path}>` is defined once in Task 1 and consumed with the identical shape in Task 2's `_prepareContext()` (`{ sounds: soundPreviewEntries() }`), Task 2's template (`{{this.label}}`/`{{this.path}}`), and Task 4's verification script (`context.sounds`, `r.label`/`r.path`/`r.key`). `SoundPreviewApp` is defined once in Task 2 and referenced by the identical name in Task 3's `registerMenu({ type: SoundPreviewApp })` and Task 4's `menuEntry.type.name` check.

**4. Review Focus:** All five items (missing-file coverage for the two spell sounds, catalog-growth safety, broadcast:false, GM-only restriction, per-row path correctness) each have a dedicated test or live-verification assertion. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-sound-preview-settings-ui.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because all four tasks are a single linear build-out of one small, already-pattern-matched UI feature (Task 2 just instantiates Task 1's one function, Task 3 just wires Task 2's one class into one registration call, and Task 4 only verifies the combination) — there's no divergent design surface between tasks for independent subagents to disagree on. Does the plan capture what you want, and which approach should we use?
