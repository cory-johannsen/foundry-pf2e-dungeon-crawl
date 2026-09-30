# Report: token-art history mining
Recovered: 90 chunk rows (chunks.csv; 84 for the 1,609 effort incl. manual batches + 6 for the separate #252 Lost Omens effort) and 444 creature rows (creatures.csv): 291 unique named creatures with a failure/redo/deferral/prompt-fix event from the 1,609 effort (~18% of 1,609), 84 manual_gemini_direction rows (not failures), 37 flagged #252 creatures.
Failures split (1,609 effort, row events): 190 redo, 64 gemini_after_failure, 42 deferred, 27 prompt_fixed.
Chunk sizes sum to ~1,689 because retry lists overlap; they are not a coverage measure. 43 chunks state a first-pass flag count: 402 of 864 (47%).
NOT recoverable: per-creature first-pass results for ~1,300 creatures (only counts, or "N of M flagged"); levels -1..3 chunks lack names for most redos (the migrated repo history starts at level 4); L19/L20 manual batches have no failure detail; many L10-L15 rejects listed only as classes; redo_rounds mostly blank.
NEW DATA found: docs/token-art-failures.csv (commit 6e8231e) is a real per-creature table with tags/kind/backend, but only for #252 (90 creatures, 37 first-pass flagged = 41%), not the 1,609.
Tag note: no allowed tag exists for monochrome/uncolored line art or decorative frames/diptychs; those are tagged unknown (101 of 291 creatures have unknown; scenery_backdrop 151, halo_or_disc 31, bg_patch 29, wrong_subject 23).
Top patterns:
1. Scenery/backdrop is the dominant failure (151 of 291 creatures; the top class in #252 too, 17 of 37).
2. Monochrome/uncolored line art (33 named creatures; hits 6 of 15 in one L6 chunk) resists shared-list fixes; needs per-entry color words.
3. Dark-palette subjects lighten SDXL backgrounds: 5 creatures failed ComfyUI, all passed Gemini first try.
4. Hybrids: 5 of 6 flagged first pass in #252; dragons 9/18; head-only crops recur in dragons.
5. Deferral dynamics: 13 deferred through L8 (all 13 resolved on first manual Gemini attempt, drider after 5 failed), 3+16+17 more at L9, then ~1-4 per chunk at L10-L15 (30 named Gemini fallbacks at L10-L15).
6. Flag rate by chunk: 15-27 of 40 early; L7-L8 rough chunks 9-11 of 15; some later chunks 3-10 of 15 (~47% overall where stated).
7. Prompt wording causes many failures (own words: reeds, wet sand, perched, flame, "ring"); rewriting the subject fixed more than adding negatives.
8. Checker is background-only: monochrome, discs not touching edges, and scenery with score 40-44 all passed; eyeballing stayed load-bearing.
