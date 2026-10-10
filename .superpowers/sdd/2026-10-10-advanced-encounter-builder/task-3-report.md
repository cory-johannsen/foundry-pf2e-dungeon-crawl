# Task 3 report

Family source (owner decision): PF2e NPCs have no family field (probed Monster Core, 492 actors, no "family" key anywhere). "family" = ancestry-style trait, case-insensitive equality against any entry of `system.traits.value` (entry.traits). No `family` echo on entries; `rarity` added via system.traits.rarity.

Implemented: `creatureMatchesFilters` (encounter-roster.mjs); levelOffsetMin/Max, family, rarity, xpCapOverride in pickCreature/resolveEncounterRoster (every look; both pick sites); xpCap===0 -> fitOffset null, no -4 fallback; appliedFilters. findCreatures: family/rarity options, rarity index field + returned rarity.
TDD: new test file 10 failed / 1 passed before implementation; 11 pass after. encounter-roster + generator tests: 79 pass.
Files: scripts/encounter-roster.mjs, scripts/foundry-api.mjs, tests/encounter-roster-force-filters.test.mjs, plan (ticks + FAMILY_FIELD note).
Concerns: findCreatures filter has no direct unit test (covered via the pure predicate). Prettier was not applied to foundry-api.mjs to avoid unrelated reformatting.
