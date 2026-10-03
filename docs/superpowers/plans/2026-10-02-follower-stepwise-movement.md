# #610 part 1 plan

Spec: docs/superpowers/specs/2026-10-02-follower-stepwise-movement-design.md

- [x] Create `scripts/token-walk.mjs` (move helpers, add `onHop`) + tests
- [x] Make `dungeon-combat.mjs` import from it; existing #479 tests still pass
- [x] `findFollowMove` returns `steps` + test
- [x] `moveFollowersToward` uses `walkTokenThroughSteps` with `onHop` suppression + test
- [x] Update `docs/architecture.md` (new file/imports), bump `module.json`
- [x] Full `npm test`, PR, automerge (no closing keyword; part 2 remains)
