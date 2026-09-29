# Lost Omens Bestiary token art Implementation Plan (#252)

> **For agentic workers:** content-generation effort; follow #16's per-chunk workflow (issue #16 "ITEM-18 resume state" comment), summarized below.

**Goal:** Wire generated token art for all 369 eligible `pf2e.lost-omens-bestiary` NPCs into `data/creature-art.json`.

**Spec:** `docs/superpowers/specs/2026-09-29-lost-omens-bestiary-token-art-design.md`. Encounter eligibility shipped separately as #289 (PR #290).

## Worklist

`docs/creature-art-todo.csv` (369 rows appended, sorted by level then name). Rows are removed as creatures are wired; deferred ones stay.

## Per-chunk workflow (~15 creatures, lowest level first)

1. Worktree + branch off `origin/main` (`issue-252-chunk-N`); copy `.env`; `.venv` with Pillow+numpy.
2. Take the next ~15 CSV rows. `grep "id: '<slug>'" tools/generate-token-art.mjs` before writing any `MONSTER_ART` prompt; suffix ids `-lob` on name collisions. Read the shared STYLE/NEGATIVE comment block first.
3. Generate (`node tools/generate-token-art.mjs <ids>`); dark-palette subjects go straight to `--backend=gemini`. Run `tools/check-token-art.mjs`; open every image and review it.
4. Redo flagged ones (try `make-bg-transparent.mjs` on flat backgrounds first): max 3 ComfyUI rounds, then Gemini. Never `rm` a rejected Gemini image before the user has seen it. Fold settled failures into the shared constants immediately.
5. Wire accepted ones into `data/creature-art.json`, delete their CSV rows.
6. `npm run validate:creature-art` + `npm test`, merge `origin/main`, bump `module.json` patch version, PR, automerge; verify with `gh pr view`.
7. Update #252's progress table and post a terse status (N/M, PR ref) at chunk start, progress, and completion.

## Done when

CSV has no `pf2e.lost-omens-bestiary` rows (or only user-acknowledged deferrals) and `npm run validate:creature-art` passes.
