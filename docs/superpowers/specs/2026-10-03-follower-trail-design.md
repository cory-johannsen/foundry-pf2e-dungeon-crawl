# #610 part 2 — followers trail along the leader's path

Part 1 (stepwise walking, PR #637) is shipped. This covers the second ask in #610: out-of-combat followers should queue single-file along the leader's actual route instead of fanning out diagonally.

## Problem
`findFollowMove` / `freeCellsNear` (`scripts/dungeon-follow-mechanics.mjs`) only see the leader's current cell. Each follower picks the free cell near its reference (the one ahead, #181) that is closest to itself, so followers approaching from similar directions scatter around the leader.

## Decision
Trail source: **reconstruct with `findPath`** (chosen over `_movement.waypoints`, whose payload shape was never confirmed live, #87). The trail may differ slightly from the exact route a player dragged.

## Design

### 1. Trail state
- Pure `extendTrail(trail, toCell, isBlocked, bounds, maxLen)` (uses `trail[0]` as the previous cell) in `dungeon-follow-mechanics.mjs`. Trail is newest-first: `trail[0]` is the leader's current cell. It runs `findPath(trail[0], toCell, ...)`, prepends the path's cells (excluding `fromCell`) newest-first, and trims to `maxLen`. `maxLen` = marching-order length + 3.
- No path (e.g. teleport) or no previous cell (first observation) resets the trail to `[toCell]`.
- `dungeon-follow.mjs` holds a per-scene `Map` of trails (like `recentlyWrittenByUs`). `followLeaderIfDue` updates it on each leader `updateToken`, comparing the leader's `_source` cell with `trail[0]`. Only the GM client moves followers, and non-GM hosts relay there, so the Map lives on the GM client.
- The trail is dropped lazily: on any leader/token position change seen during combat. A leader walking back over its own route collapses the trail. Run start and scene change self-heal (a stale trail either no-paths and resets, or keeps only the newest cells).

### 2. Follower targeting
- In marching order, follower `i` (0-based) aims for `trail[i + 1]`.
- Fall back to today's `findFollowMove` ("free cell near the one ahead") when: the trail is too short; the trail cell is occupied by anyone but this follower; no path reaches it; or the follower is larger than 1x1 (footprint makes "the cell behind" ambiguous; out of scope).
- A follower already on or adjacent to its trail cell stays put.
- Result shape matches `findFollowMove` (`status`, `to`, `steps`) so `moveFollowersToward` and part 1's `walkTokenThroughSteps` need no change beyond choosing the target.

### 3. Walking
Reuses part 1 unchanged: hop-by-hop `{teleport:true}` walk to the trail cell.

## Testing
- `extendTrail`: straight run, wall detour, no-path reset, first observation, trimming.
- Targeting: leader walking along an axis with three followers ends single-file; corridor and doorway cases fall back to existing behavior (existing tests stay green); oversized follower uses fallback; occupied trail cell uses fallback.
- Glue: trail updates only for the leader's own moves; cleared on combat start.
- Live playtest needed (as with #141): whether a real drag fires one or several `updateToken` calls. The trail extends per call, so either works.

## Out of scope
Using `_movement.waypoints`; formation for oversized followers; combat-time formation.
