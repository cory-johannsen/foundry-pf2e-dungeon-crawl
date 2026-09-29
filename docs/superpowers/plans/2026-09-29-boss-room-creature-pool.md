# Boss-room creature pool Implementation Plan (#289)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** The dungeon's final (`isGoal`) combat room draws its boss from non-general (adventure/Lost Omens/PFS) bestiary packs; ordinary rooms demote those packs to last resort.

**Architecture:** `findCreatures` gains an `excludePacks` filter. `pickCreature` gains a `boss` mode and a `GENERAL_PACKS` tier. `resolveEncounterRoster` marks only the first foe slot as boss when `isBoss`. `isBoss: room.isGoal` is threaded `dungeon-scene.mjs` -> `populateSlotEncounter` -> `generateEncounter` -> `getGenerator().generateEncounterRoster`.

**Tech Stack:** ES modules, vitest (`npm test`).

**Spec:** `docs/superpowers/specs/2026-09-29-lost-omens-bestiary-token-art-design.md` ("Decision" section, on branch `issue-252-spec`).

## Global Constraints

- Bump `module.json` `version` (minor: new behavior); never reuse a version.
- Run `update-architecture-docs` only if imports change (none expected).
- "General" packs = `pf2e.pathfinder-monster-core`, `-monster-core-2`, `pathfinder-bestiary`, `-bestiary-2`, `-bestiary-3`, `pathfinder-npc-core`, `npc-gallery` (the 7 core packs of #16). Boss pool = every other pack matching `CREATURE_PACK_PATTERN`.
- Never make an ordinary room's result worse than today: still falls back to all packs.

## Review Focus

- Boss room, no non-general creature in level band: falls back to normal ladder, still returns a creature.
- Boss room with `group`ed first foe slot: boss is shared across the group (acceptable).
- Non-boss room where only a boss-pool creature fits: still picked (last resort).
- Only foe slot index 0 is boss; later foes, friend, lurker, twins are not.
- Callers omitting `isBoss` (standalone macro, agent-service generator) behave exactly as before.

---

### Task 1: `excludePacks` in findCreatures

**Files:** Modify `scripts/foundry-api.mjs` (findCreatures, ~L245-265).

- [ ] Add param `excludePacks = []` to `findCreatures`; in the `packs ??=` default chain add `.filter((p) => !excludePacks.includes(p.collection))` after the pattern filter, and skip ids in `excludePacks` in the `for (const id of packs)` loop.
- [ ] Run `npm test`; commit "findCreatures: excludePacks filter (#289)".

### Task 2: pickCreature boss/general tiers

**Files:** Modify `scripts/encounter-roster.mjs`; Test `tests/encounter-roster.test.mjs`.

**Interfaces:** Produces `pickCreature({..., boss = false})`; `resolveEncounterRoster({..., isBoss = false})`. Stub `findCreatures(opts)` receives `packs` and `excludePacks`.

- [ ] Extend `makeStubApi` in the test to honor `opts.packs` (`c.pack` in packs) and `opts.excludePacks` (`c.pack` not in it).
- [ ] Write failing tests (each a `describe("boss room pool")` case using `resolveEncounterRoster` with one foe slot `{id:"s1",kind:"creature",levelOffset:0}`):
  1. `isBoss:true`, pool has `{pack:"pf2e.pathfinder-monster-core", id:"m"}` and `{pack:"pf2e.lost-omens-bestiary", id:"v"}` both level 5 -> foes[0].id === "v".
  2. `isBoss:true`, pool only the core creature -> foes[0].id === "m".
  3. `isBoss:false`, pool with core `m` and boss-pool `v` -> id "m" (already true) AND with only `v` -> id "v" (last resort).
  4. `isBoss:false`, pool: `{pack:"pf2e.pathfinder-bestiary", id:"b"}` and `v` (no core) -> "b" (general before boss pool).
  5. `isBoss:true`, two foe slots, pool with core `m` and boss `v` -> foes[0].id "v", foes[1].id "m".
- [ ] Run `npx vitest run tests/encounter-roster.test.mjs`; expect the new tests FAIL.
- [ ] Implement in `encounter-roster.mjs`:
```js
const GENERAL_PACKS = [
  ...MONSTER_CORE_PACKS,
  "pf2e.pathfinder-bestiary",
  "pf2e.pathfinder-bestiary-2",
  "pf2e.pathfinder-bestiary-3",
  "pf2e.pathfinder-npc-core",
  "pf2e.npc-gallery",
];
```
  In `pickCreature` add `boss = false`; extend `look` to `(packs, useTraits, excludePacks = [])` passing `excludePacks`. Ladder:
```js
let pool = [];
if (boss) {
  pool = await look(null, true, GENERAL_PACKS);
  if (!pool.length) pool = await look(null, false, GENERAL_PACKS);
}
if (!pool.length) pool = await look(MONSTER_CORE_PACKS, true);
if (!pool.length) pool = await look(GENERAL_PACKS, true);
if (!pool.length) pool = await look(null, true);
if (!pool.length) pool = await look(null, false);
```
  Existing tests assert call counts (e.g. "toHaveLength(3)" in requireTrait test): update those counts for the added general tier (now 4) and re-verify with comments.
  In `resolveEncounterRoster` add `isBoss = false`; `pick = (levelOffset, boss = false) => pickCreature({..., boss})`; `choiceFor(slot, boss)` passes it to both `pick` calls; in the foes loop use `resolved.foes.indexOf(slot) === 0 && isBoss`. Friend/lurker/twins call `pick` unchanged.
- [ ] Run full `npm test`; expect PASS. Commit "pickCreature: boss pool + general tier (#289)".

### Task 3: thread isBoss from the goal room

**Files:** Modify `scripts/encounter-generator.mjs` (generateEncounter param `isBoss = false`, pass `isBoss` in the `generateEncounterRoster` call ~L194); `scripts/dungeon-scene.mjs` (`populateSlotEncounter` option `isBoss = false` forwarded to `generateEncounter`; call at ~L1238 passes `isBoss: room.isGoal`). Test: extend `tests/encounter-generator.test.mjs` only if it already stubs `generateEncounterRoster`; otherwise cover by grep.

- [ ] Make the edits; `grep -n isBoss scripts/*.mjs` shows all four hops.
- [ ] Check `scripts/agent-service*`/`tools/agent-service` generators ignore the extra arg (they receive an object; confirm no strict validation).
- [ ] `npm test`; bump `module.json` minor; commit "Thread isBoss from goal room (#289)".

### Task 4: live check + PR

- [ ] Compare live world's module version vs branch (see worktree note); read-only sanity query that `pf2e.lost-omens-bestiary` is not in GENERAL_PACKS.
- [ ] Push, PR `Fix #289`, automerge, verify merged via `gh pr view`.
