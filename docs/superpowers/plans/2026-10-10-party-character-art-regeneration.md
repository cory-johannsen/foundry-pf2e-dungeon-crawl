# Party Character Art Regeneration (Cleric & Thief) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regenerate the Cleric and Thief portrait/token art with the current ComfyUI token pipeline, reviewed and applied to the live world only (#1260).

**Architecture:** Export the existing private helpers from `tools/generate-token-art.mjs`, add a pure `tools/party-art-lib.mjs` (validation, seeds, prompt, versioned filenames, apply plan, contact-sheet layout) and a thin CLI `tools/generate-party-art.mjs` with three modes: generate (4 candidates per subject into a staging dir outside the repo), apply (copy the picked webp to a new versioned filename in the Foundry data dir and update Actor, prototype token and placed tokens through the `foundry-rest` skill), revert. Nothing generated is committed.

**Tech Stack:** Node ESM tools, ComfyUI HTTP API (DreamShaper XL Lightning defaults), Python PIL via `.venv/bin/python3` (existing `shrink`/`backgroundScore`), `foundry-rest` skill, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-party-character-art-regeneration-design.md`

## Global Constraints

- ComfyUI only; never call Gemini/OpenRouter or any paid backend (the Gemini API is out of credits; paid backends need the owner's say). If every candidate for a subject fails the background check, report and stop for that subject.
- Generated images, subject files, staging dirs, manifests, contact sheets and the files in the Foundry data dir are **never committed** and never go into `assets/`, `data/creature-art.json` or the generated-creature-art pack.
- Staging dir default: `~/src/art-tools/out/party-art/<YYYY-MM-DD>/` (outside the repo).
- Old files (`/srv/foundry/data/Data/party-portraits/<id>.webp`) are kept until the owner confirms; never delete a generated or old image before the owner has seen the replacement.
- Subject lines are approved by the owner **before any generation**.
- Output is one 512×512 webp per character (portrait and token share it); target filenames `party-portraits/<id>-vN.webp` (next free N, starting at `-v2`).
- Seeds: derived from subject id, candidate index and `--reroll` with a modulo on every reduce step (the generator's documented precision pitfall), so reruns reproduce.
- Every merge to `main` bumps `module.json` `version` (currently `0.95.1`; patch bump; re-read `origin/main` at merge time, never reuse a number).
- No import-graph change under `scripts/` or `tools/agent-service/`, so `update-architecture-docs` is not required.
- Worktree off `origin/main`; `npm ci`; copy `.env` before live work. Note `shrink`/`backgroundScore` use `<repo root>/.venv/bin/python3`; a fresh worktree has no `.venv`, and `shrink` then silently writes PNG bytes under a `.webp` name — the new CLI must refuse to run without a working Python/Pillow (Task 3).

## Review Focus

- Python/Pillow missing → fail loudly, never write PNG bytes as `.webp`.
- ComfyUI unreachable mid-run → no partial files kept, rerun resumes only missing candidates (existing `cand-N.webp` are skipped, `--force` regenerates).
- `--pick` naming a nonexistent candidate or subject, or `--apply` without manifest/pick → refuse before touching the world.
- A scene token/actor not found → reported in `applied.json`, the rest of the apply continues; revert restores exactly what `applied.json` lists, and never deletes the new files unless `--delete-new` is given.
- Versioned filename picker with gaps and non-numeric lookalikes (`cleric-v2.webp`, `cleric-v10.webp`, `cleric-vx.webp`, `cleric.webp`) → `-v11`.
- Exports added to `generate-token-art.mjs` must not change its CLI behavior or outputs.

## File Structure

| File | Responsibility |
|---|---|
| `tools/generate-token-art.mjs` | Gains named exports only (`promptFor`, `negativeFor`, `build`, `enqueue`, `waitFor`, `fetchImage`, `backgroundScore`, `shrink`, `CLEAN_THRESHOLD`, `MAX_ATTEMPTS`, `trySalvage`). |
| `tools/party-art-lib.mjs` (new) | Pure helpers. |
| `tools/generate-party-art.mjs` (new) | CLI: generate / apply / revert; contact sheet. |
| `tests/party-art-lib.test.mjs` (new) | Pure-helper tests. |
| `tests/generate-token-art-exports.test.mjs` (new) | Export surface + prompt regression. |
| `README.md` | Art-tools entry. |

---

### Task 1: Export the pipeline helpers

**Files:**
- Modify: `tools/generate-token-art.mjs` (`promptFor` ~11121, `negativeFor` ~11126, `build` ~11144, `enqueue` ~11157, `waitFor`, `fetchImage`, `backgroundScore`, `shrink`, `CLEAN_THRESHOLD`, `MAX_ATTEMPTS`, `trySalvage` ~11268)
- Test: `tests/generate-token-art-exports.test.mjs`

**Interfaces:**
- Produces: the named exports listed above, signatures unchanged (`promptFor(s)`, `negativeFor(s)`, `build(prompt, seed, prefix, negative?)`, `enqueue(workflow) → promptId`, `waitFor(promptId, {timeoutMs}?) → imageRef`, `fetchImage(imageRef) → Buffer`, `backgroundScore(path) → number|null`, `shrink(src, dest)`, `trySalvage(path, score) → number|null`).

- [x] **Step 1: Write the failing test**

```js
import { describe, it, expect } from "vitest";
import * as gen from "../tools/generate-token-art.mjs";

describe("generate-token-art exports (#1260)", () => {
  it("exposes the pipeline helpers the party script reuses", () => {
    for (const name of ["promptFor","negativeFor","build","enqueue","waitFor","fetchImage","backgroundScore","shrink","trySalvage"])
      expect(typeof gen[name], name).toBe("function");
    expect(gen.CLEAN_THRESHOLD).toBe(45);
    expect(gen.MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });
  it("importing does not run the CLI", () => { /* reaching this line = main() did not execute/exit */ expect(true).toBe(true); });
  it("promptFor/negativeFor keep their existing behavior", () => {
    expect(gen.promptFor({ who: "a dwarf" })).toContain("Portrait bust of a dwarf, wearing full plate armour");
    expect(gen.promptFor({ prompt: "x" })).toBe(`x, ${gen.STYLE}`);
    expect(gen.negativeFor({})).toBe(gen.NEGATIVE);
    expect(gen.negativeFor({ avoid: "beard" })).toBe(`${gen.NEGATIVE}, beard`);
    expect(gen.build("p", 5, "pre")["5"].inputs.seed).toBe(5);
  });
});
```

- [x] **Step 2: Run to verify it fails** — `npx vitest run tests/generate-token-art-exports.test.mjs` → FAIL (`promptFor` etc. undefined).
- [x] **Step 3: Implement** — prefix each listed declaration with `export` (`export const promptFor`, `export async function enqueue`, …). No other edits.
- [x] **Step 4: Run** the new test plus `npx vitest run tests/art-failure-lib.test.mjs tests/creature-art.test.mjs` → PASS. Also `node tools/generate-token-art.mjs nonexistent-id` must print nothing and exit 0 (CLI unchanged).
- [x] **Step 5: Commit** — `git add -A tools tests && git commit -m "#1260: export token-art pipeline helpers"`

### Task 2: Pure party-art helpers (`party-art-lib.mjs`)

**Files:**
- Create: `tools/party-art-lib.mjs`
- Test: `tests/party-art-lib.test.mjs`

**Interfaces:**
- Consumes: `STYLE` (not imported here; the prompt composer takes it as a parameter to keep the lib pure).
- Produces:
  - `validateSubjects(list) → { ok, errors: string[] }` — array, each `{ id: /^[a-z0-9-]+$/, who: non-empty string, avoid?: string, notes?: string }`, ids unique.
  - `seedFor(id, index, reroll = 0) → integer in [0, 2_000_000_000)` — `base = reduce((a,c)=>(a*31+code)%2e9, 7)`, `(base + reroll*104729 + index*7919) % 2e9` (modulo each step).
  - `partyPromptFor(subject, style) → string`: `` `Portrait bust of ${who}, ${style}` `` (the approved `who` carries class/gear; no warrior suffix); `partyNegativeFor(subject, negative) → string` appends `avoid`.
  - `nextVersionedName(existing: string[], id) → string` (`<id>-vN.webp`, N = max existing `^<id>-v(\d+)\.webp$` + 1, minimum 2).
  - `contactSheetLayout(subjects, count, cell = 512, label = 40) → { width, height, tiles: [{ id, index, x, y, w, h }] }` (one row per subject, `count` columns).
  - `buildApplyPlan({ picks: {id: n}, manifest, actors: {id: {actorId, tokens:[{sceneId?, tokenId}]}}, existingFiles, dataDir }) → { copies:[{from,to}], documentUpdates:[{actorId, img, tokens}], errors }` — refuses (errors) a pick whose candidate is not in the manifest or a subject without an actor mapping; `to` is `<dataDir>/party-portraits/<name>` and doc paths are `party-portraits/<name>`.
  - `buildRevertPlan(applied) → { documentUpdates }` from an `applied.json` (`{ entries:[{id, actorId, oldImg, newImg, tokens:[{tokenId, sceneId, oldSrc, ok}]}] }`), restoring only tokens with `ok: true`.

- [x] **Step 1: Write failing tests**

```js
import { describe, it, expect } from "vitest";
import { validateSubjects, seedFor, partyPromptFor, partyNegativeFor, nextVersionedName,
         contactSheetLayout, buildApplyPlan, buildRevertPlan } from "../tools/party-art-lib.mjs";

describe("validateSubjects", () => {
  it("accepts good, rejects bad", () => {
    expect(validateSubjects([{ id: "cleric", who: "a leshy" }]).ok).toBe(true);
    expect(validateSubjects([{ id: "Cleric", who: "x" }]).ok).toBe(false);
    expect(validateSubjects([{ id: "a", who: "" }]).ok).toBe(false);
    expect(validateSubjects([{ id: "a", who: "x" }, { id: "a", who: "y" }]).ok).toBe(false);
    expect(validateSubjects({}).ok).toBe(false);
  });
});
describe("seedFor", () => {
  it("is deterministic, bounded, and varies with index and reroll (long ids too)", () => {
    const long = "a-very-long-party-subject-identifier";
    expect(seedFor("cleric", 0)).toBe(seedFor("cleric", 0));
    expect(new Set([0,1,2,3].map((i) => seedFor("cleric", i))).size).toBe(4);
    expect(seedFor(long, 0, 0)).not.toBe(seedFor(long, 0, 1));
    for (const s of [seedFor(long, 3, 9), seedFor("x", 0)]) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThan(2_000_000_000); expect(Number.isSafeInteger(s)).toBe(true); }
  });
});
describe("prompts", () => {
  it("composes from who + style, negative appends avoid", () => {
    expect(partyPromptFor({ who: "a halfling rogue" }, "STYLE")).toBe("Portrait bust of a halfling rogue, STYLE");
    expect(partyNegativeFor({ avoid: "beard" }, "NEG")).toBe("NEG, beard");
    expect(partyNegativeFor({}, "NEG")).toBe("NEG");
  });
});
describe("nextVersionedName", () => {
  it("starts at v2 and skips lookalikes", () => {
    expect(nextVersionedName(["cleric.webp"], "cleric")).toBe("cleric-v2.webp");
    expect(nextVersionedName(["cleric-v2.webp", "cleric-v10.webp", "cleric-vx.webp", "thief-v7.webp"], "cleric")).toBe("cleric-v11.webp");
    expect(nextVersionedName([], "thief")).toBe("thief-v2.webp");
  });
});
describe("contactSheetLayout", () => {
  it("one row per subject, count columns", () => {
    const l = contactSheetLayout([{ id: "a" }, { id: "b" }], 4, 512, 40);
    expect(l.width).toBe(2048); expect(l.height).toBe(2 * (512 + 40)); expect(l.tiles).toHaveLength(8);
    expect(l.tiles[5]).toMatchObject({ id: "b", index: 1, x: 512, y: 552 });
  });
});
describe("buildApplyPlan / buildRevertPlan", () => {
  const manifest = { subjects: { cleric: { candidates: [1,2,3,4] }, thief: { candidates: [1,2,3,4] } } };
  const actors = { cleric: { actorId: "A", tokens: [{ sceneId: "S", tokenId: "T1" }] }, thief: { actorId: "B", tokens: [] } };
  it("plans copies to the next free version and document updates", () => {
    const plan = buildApplyPlan({ picks: { cleric: 2, thief: 3 }, manifest, actors, existingFiles: ["cleric.webp", "thief.webp", "thief-v2.webp"], dataDir: "/d", stagingDir: "/s" });
    expect(plan.errors).toEqual([]);
    expect(plan.copies).toEqual([{ from: "/s/cleric/cand-2.webp", to: "/d/party-portraits/cleric-v2.webp" }, { from: "/s/thief/cand-3.webp", to: "/d/party-portraits/thief-v3.webp" }]);
    expect(plan.documentUpdates[0]).toMatchObject({ actorId: "A", img: "party-portraits/cleric-v2.webp", tokens: [{ sceneId: "S", tokenId: "T1" }] });
  });
  it("refuses unknown candidates and unmapped subjects", () => {
    expect(buildApplyPlan({ picks: { cleric: 9 }, manifest, actors, existingFiles: [], dataDir: "/d", stagingDir: "/s" }).errors.length).toBe(1);
    expect(buildApplyPlan({ picks: { ghost: 1 }, manifest, actors, existingFiles: [], dataDir: "/d", stagingDir: "/s" }).errors.length).toBe(1);
  });
  it("revert restores only ok tokens", () => {
    const r = buildRevertPlan({ entries: [{ id: "cleric", actorId: "A", oldImg: "party-portraits/cleric.webp", newImg: "x", tokens: [{ tokenId: "T1", sceneId: "S", oldSrc: "party-portraits/cleric.webp", ok: true }, { tokenId: "T2", sceneId: "S", oldSrc: "o", ok: false }] }] });
    expect(r.documentUpdates[0].tokens).toEqual([{ tokenId: "T1", sceneId: "S", oldSrc: "party-portraits/cleric.webp" }]);
    expect(r.documentUpdates[0].img).toBe("party-portraits/cleric.webp");
  });
});
```

- [x] **Step 2: Run, FAIL** — `npx vitest run tests/party-art-lib.test.mjs`.
- [x] **Step 3: Implement** `tools/party-art-lib.mjs` to satisfy the interfaces above (plain functions, no I/O, no imports).
- [x] **Step 4: Run, PASS.**
- [ ] **Step 5: Commit** — `git add tools/party-art-lib.mjs tests/party-art-lib.test.mjs && git commit -m "#1260: pure party-art helpers"`

### Task 3: Generation CLI

**Files:**
- Create: `tools/generate-party-art.mjs`

**Interfaces:**
- Consumes: Task 1 exports, Task 2 lib. CLI: `node tools/generate-party-art.mjs --subjects <file.json> --out <dir> [--count 4] [--reroll N] [--only id] [--force]`.
- Produces in `<out>`: `subjects.json` (copy of the approved subjects), `<id>/cand-N.webp`, `manifest.json` (`{ createdAt, model: CHECKPOINT, steps, cfg, subjects: { [id]: { who, prompt, negative, candidates: [{ index, seed, score, ok }] } } }`), `contact-sheet.png`.

Behavior:
1. Preflight: `validateSubjects`; run `.venv/bin/python3 -c "import PIL, numpy"` (resolve the interpreter the same way `shrink` does; if the worktree has none, also accept the main checkout's `.venv`) — on failure exit 2 with "Pillow/numpy required: create .venv" (never fall through to `shrink`'s PNG-bytes fallback).
2. For each subject and candidate index 1..count: skip if `<id>/cand-N.webp` exists and not `--force`; else up to `MAX_ATTEMPTS` attempts with seed `seedFor(id, index, reroll) + attempt*7919` via `enqueue(build(partyPromptFor(...), seed, 'pf2edc-party-<id>', partyNegativeFor(...)))`, `waitFor`, `fetchImage` → temp PNG in `<out>/.tmp`; `backgroundScore`; `trySalvage` when ≥ `CLEAN_THRESHOLD`; keep the best attempt; `shrink(best, cand-N.webp)`; record `{ index, seed, score, ok: score < CLEAN_THRESHOLD }`. A ComfyUI error counts as a failed attempt; if every attempt for a candidate errors, record `ok:false` and continue (no partial file).
3. Subjects where **every** candidate has `ok:false` → print `FAILED <id>: no clean candidate (reroll, change the prompt, or hand-make)` and exit code 3 at the end; no paid-backend fallback.
4. Write `manifest.json` and the contact sheet (PIL script via `execFileSync(python, ['-c', script, layoutJson, ...])` pasting `cand-N.webp` tiles at `contactSheetLayout` positions, labeled `id #N` and `FAIL` for `ok:false`).

- [x] **Step 1:** Implement as specified; keep `main()` behind `if (import.meta.url === \`file://${process.argv[1]}\`)`.
- [x] **Step 2: Smoke test without ComfyUI** — `node tools/generate-party-art.mjs --subjects /nonexistent.json --out $TMPDIR/x` exits non-zero with a clear message; with a one-subject file and `COMFYUI_BASE_URL=http://127.0.0.1:1` it records `ok:false` candidates, writes no `cand-*.webp`, exits 3.
- [x] **Step 3:** `npm test` → PASS. **Step 4: Commit** — `git commit -am "#1260: party art generation CLI"`.

### Task 4: Apply / revert modes

**Files:**
- Modify: `tools/generate-party-art.mjs`

**Interfaces:**
- Consumes: `buildApplyPlan`, `buildRevertPlan`, `.claude/skills/foundry-rest/foundry-exec.sh` (run from the repo root; exit 3 = socket dropped → retry up to 3 times; use small scripts).
- CLI: `--apply --manifest <out>/manifest.json --pick cleric=2,thief=3 [--dry-run]`; `--revert <out>/applied.json [--delete-new]`.

Behavior:
- **Apply:** refuse without `--manifest` and `--pick` (exit 2). Resolve actors/tokens live with one read-only foundry-rest script: for subject `id` find the actor by the mapping in `<out>/subjects.json` field `actorId` (**add `actorId` as an optional field in the subject schema; validate it is a 16-char id when present**; the apply step requires it) and list `game.scenes` tokens whose `actorId` matches (`[{sceneId, tokenId, src}]`, so a token on any scene is covered and old `src` values are captured for revert). Build the plan (`existingFiles` = `readdirSync('/srv/foundry/data/Data/party-portraits')`, dataDir `/srv/foundry/data/Data`); on any plan error exit before touching anything. `--dry-run` prints copies + document updates and exits 0. Otherwise: `copyFileSync` each pick; then for each actor run a foundry-rest script doing `await actor.update({ img, "prototypeToken.texture.src": img })` and per token `await scene.tokens.get(tokenId).update({ "texture.src": img })`, catching per-token errors; write `<out>/applied.json` (`{ appliedAt, entries:[{ id, actorId, oldImg, oldProto, newImg, tokens:[{ tokenId, sceneId, oldSrc, ok, error? }] }] }`) after each actor so a mid-run failure is still revertible. Then re-read the actor/tokens and print a verification table (img, proto src, each token src). Never deletes old files.
- **Revert:** `buildRevertPlan(applied)`; run the inverse updates (actor `img` + proto restored, tokens with `ok:true` restored); never delete the new files unless `--delete-new`.
- foundry-rest scripts must avoid the banned words (`apiKey`, `globalThis`, `eval(`, `import(`, `new Function`, `localStorage`, `sessionStorage`, `password`, `game.settings.set`) — including in comments.

- [x] **Step 1:** Add a unit test for the script-text builders (extract `actorReadScript(actorIds)`, `applyScript(update)`, `revertScript(update)` as pure functions into `party-art-lib.mjs` and assert in `tests/party-art-lib.test.mjs` that none contains a banned word and each embeds the ids/paths via `JSON.stringify`, so quoting cannot break).
- [x] **Step 2:** Implement apply/revert with `execFileSync` of `foundry-exec.sh` (feeding the script on stdin).
- [x] **Step 3: Dry-run test:** with a hand-written manifest and a fake data dir (`--data-dir` override for tests), `--apply --dry-run` prints the plan and writes nothing; missing `--pick` exits 2.
- [x] **Step 4:** `npm test` → PASS. **Step 5: Commit** — `git commit -am "#1260: party art apply and revert"`.

### Task 5: Docs, version, and the reviewed run

**Files:** `README.md` (art-tools section: usage, outside-repo staging, apply/revert, "never committed"), `module.json` (patch bump).

- [x] **Step 1:** README entry + script header usage note; bump `module.json`; `npm test` → PASS; commit `#1260: document party art tool, bump version`; open the PR (merge it before the live run so the tool is on `main`).
- [ ] **Step 2: Subject approval gate (owner).** Read both live actors via foundry-rest (ancestry, heritage, class, deity, equipped weapons/armor, identifying gear — Cleric `JXoEHUzeuuvD5m75`, Thief `Wd5KR4tYminiWPEh`). Draft `subjects.json` in the staging dir (`id`, `actorId`, `who`, `avoid`), seeded from the spec: Cleric = Chrysanthemum leshy cleric (carved wooden gourd head with cut-out eyes/mouth, chrysanthemum petal ring, vine-and-leaf body, vestments, visible holy symbol of the deity) with the `leshy` subject's `avoid` list; Thief = Hillock halfling rogue (small, round-cheeked, curly hair, clever cheerful face under a dark hood, leather armor, dagger at the belt, full saturated colour). **Show both to the owner and wait for approval or edits before generating.**
- [ ] **Step 3: Generate** `node tools/generate-party-art.mjs --subjects <dir>/subjects.json --out <dir>`; inspect every candidate for defining features (gourd head + holy symbol; halfling proportions, colour, rogue gear; plain dark background; one subject), mark failures, show the contact sheet to the owner; reroll with `--reroll` or a prompt change on request. Nothing touches the world before the owner's pick.
- [ ] **Step 4: Apply** with the owner's `--pick` (first `--dry-run`, show it). Verify in the world: both sheets, both prototype tokens and both placed tokens show the new art; an open second client refreshes without a hard reload; old files still present.
- [ ] **Step 5:** Ask the owner to confirm. Only after the confirmation delete the old `cleric.webp`/`thief.webp` (leave `applied.json` for reference). If rejected: `--revert`, then reroll.
- [ ] **Step 6:** Issue handling per CLAUDE.md: after the PR merges, the issue stays open until the owner confirms the art in-world, then close it (label `verification` meanwhile; no closing keyword in the PR).

## Self-Review

Spec coverage: shared helper exports (T1); script modes, 4 candidates, seeds, manifest, contact sheet, ComfyUI-only, stop-on-all-fail (T3); subject file + approval gate (T5/T3); review gate with defining-feature inspection (T5); apply to versioned filenames, Actor + prototype + placed tokens on any scene, `applied.json`, verify, keep old files, revert, dry-run (T4); not committed / staging outside repo (Global Constraints); error handling (T3/T4 + Review Focus); testing (pure units T2, regression T1, dry-run T4, live acceptance T5). Spec's open questions resolved: export list in T1; live access = `foundry-rest` relay with small scripts (retry on exit 3), chosen over an in-world script because it is already the project's tested path. Names consistent: `seedFor`, `partyPromptFor`, `partyNegativeFor`, `nextVersionedName`, `contactSheetLayout`, `buildApplyPlan`, `buildRevertPlan`, `actorReadScript`/`applyScript`/`revertScript`.
