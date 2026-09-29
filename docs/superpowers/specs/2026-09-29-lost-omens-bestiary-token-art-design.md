# Lost Omens Bestiary token art + encounter eligibility (#252)

Part of #229 (first child in its priority order). Predecessor: #16.

## Live findings (2026-09-29)

- `pf2e.lost-omens-bestiary`: 397 entries, 389 `npc`. **All 389 use `systems/pf2e/icons/default-icons/npc.svg`** (no art at all).
- 20 carry `troop`/`swarm` (`MANDATORY_EXCLUDE`) → **369 eligible**, no duplicate names within the pack.
- Levels -1..24, densest at 10–11 (24 each), 18 (27), 20 (24), 21–23 (~20 each). Many high-level creatures; expect a high share of dark-palette subjects (see Gemini-first rule).
- `findCreatureArt` keys on `{pack, docId}`, so cross-pack name collisions need no disambiguation suffix in the lookup; suffixes only matter for `MONSTER_ART` prompt ids (use `-lob`).
- `CREATURE_PACK_PATTERN` (`/bestiary|.../`) already matches this pack, and `pickCreature`'s second fallback (`packs = null`) already searches it. **No code change is needed for reachability**; it is only used when Monster Core has no match in the level band.

## Scope

1. Build worklist rows for the 369 eligible creatures (append to `docs/creature-art-todo.csv`, same columns).
2. Generate + review + wire art via the #16 pipeline, ~15 per chunk (~25 chunks), one worktree/branch/PR each. Dark-palette subjects go straight to `--backend=gemini`; others get up to 3 ComfyUI rounds then Gemini. Rejected paid images stay on disk until the user has seen them.
3. Track progress in #252's table, updated live.

## Open decision: encounter eligibility

The issue asks to "expand `pickCreature`'s pack fallback". Since the pack is already reachable, options:

- A. No change (recommended default): art ships, pack is naturally used as fallback.
- B. Add the pack to `MONSTER_CORE_PACKS`-style preferred tier: would surface Golarion named villains in random encounters, which that constant's comment explicitly avoids.
- C. Prefer art-having creatures within the fallback tier.

Recommendation: A for this issue; C, if wanted, as a single cross-cutting change tracked on #229 rather than per pack.
