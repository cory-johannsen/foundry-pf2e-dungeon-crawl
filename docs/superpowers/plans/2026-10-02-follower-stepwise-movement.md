# #610 part 1 plan

Spec: docs/superpowers/specs/2026-10-02-follower-stepwise-movement-design.md

- [ ] Create `scripts/token-walk.mjs` (move helpers, add `onHop`) + tests
- [ ] Make `dungeon-combat.mjs` import from it; existing #479 tests still pass
- [ ] `findFollowMove` returns `steps` + test
- [ ] `moveFollowersToward` uses `walkTokenThroughSteps` with `onHop` suppression + test
- [ ] Update `docs/architecture.md` (new file/imports), bump `module.json`
- [ ] Full `npm test`, PR, automerge (no closing keyword; part 2 remains)
