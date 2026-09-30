# Token-art history (recovered)

Recovered from git history, issue #16 and the dated comments in
`tools/generate-token-art.mjs` (mined 2026-09-29, #308). **Failures only**: the
original ITEM-18 effort never kept a per-creature table, so there are no
"accepted first time" rows and no way to compute true failure rates per kind.

- `creatures.csv` — one row per named creature event: `redo`, `deferred`,
  `gemini_after_failure`, `prompt_fixed`, or `manual_gemini_direction`.
  **`manual_gemini_direction` rows are NOT failures** (levels 18-25 moved to
  manual Gemini because the owner directed a workflow change).
- `chunks.csv` — one row per generation chunk: size, first-pass flag count where
  the text states it, backend, source.
- `failure_classes.md` — the recurring failure classes and the fixes baked into the
  shared STYLE/NEGATIVE prompt constants.
- `mining-report.md` — what was and wasn't recoverable.

Caveats: about a third of failed creatures are named; some slugs/levels are inferred;
the stated first-pass flag rate over the 43 chunks that give one is 402 of 864 (47%).
`node tools/analyze-art-failures.mjs --history` reports how over-represented name
groups are among the recovered failures (a **lower bound** on their true rate, since
unnamed failures are missing).

The live per-creature log for the Lost Omens effort is `docs/token-art-failures.csv`.
