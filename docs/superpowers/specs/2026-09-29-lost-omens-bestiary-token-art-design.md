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

## Decision: encounter eligibility (resolved 2026-09-29)

Owner chose B with a refinement: named villains in this (and later adventure) packs are **bosses for the dungeon's final room**, not random-encounter fodder.

Plumbing found: `dungeon-scene.mjs` (~L1238) populates a `combat` room via `populateSlotEncounter` -> `generateEncounter` -> `resolveEncounterRoster` -> `pickCreature`; the final room is `room.isGoal` (already gets `MAX_DEPTH_BIAS`). Nothing boss-specific reaches `pickCreature` today.

Design (cross-cutting, tracked as its own issue and listed under #229's pipeline changes, since every pack child needs it):
- Add `BOSS_PACK_PATTERN`/pool = packs matching `CREATURE_PACK_PATTERN` that are not Monster Core.
- Thread `isBoss: room.isGoal` from `dungeon-scene.mjs` down to `pickCreature`.
- `isBoss` rooms: try the boss pool first (level band already maxed), then fall back to current behavior.
- Non-boss rooms: Monster Core first, then non-boss-pool packs, boss pool only as a last resort so an empty result is still never worse than today.
- Open detail: whether the boss room's other slots (minions) stay Monster Core (recommended: only the first foe slot is the boss).

This issue (#252) only ships art. Boss-room behavior shipped as #289 (PR #290, v0.50.0).
