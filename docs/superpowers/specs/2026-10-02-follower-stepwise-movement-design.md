# #610 part 1 — followers step one square at a time

Part 2 (trail-following) is out of scope here; it needs its own design.

## Goal
Out-of-combat followers visibly step one cell at a time (as combat does since #479) instead of one teleport to the final cell.

## Design
- New `scripts/token-walk.mjs` holds `walkTokenThroughSteps`, `readPacingSetting`, `movementStepDelayMs` and `MOVEMENT_STEP_DELAY_MS`, moved verbatim from `dungeon-combat.mjs`. A shared leaf module avoids a `dungeon-follow` → `dungeon-combat` import.
- `walkTokenThroughSteps` gains an optional `onHop` callback, called before and after each hop's write.
- `findFollowMove` returns `steps` (the found path minus its start cell) alongside `to`.
- `moveFollowersToward` walks `result.steps` via `walkTokenThroughSteps`, passing `onHop = () => markRecentlyWritten(token.id)` so the #87 resnap suppression window covers every hop.
- Every hop keeps `{teleport:true}` (#87/#141/#361).

## Known tradeoff
Followers walk sequentially (each awaits its own steps), so the scene stays `inFlight` for the whole walk; a leader move during that window is already debounced/queued by the existing `inFlightScenes` guard.
