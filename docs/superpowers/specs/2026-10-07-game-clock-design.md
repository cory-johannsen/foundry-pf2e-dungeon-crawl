# Game Clock Design

**Issue:** #785 — enable game time tracking using Foundry's game clock.

**Status:** Approved via conversational design (this session). Scope narrowed twice during design, both confirmed with the owner: (1) combat rounds and rests are already handled by existing Foundry/PF2e core behavior, not new code; (2) UI display of elapsed time is explicitly deferred to a separate future issue.

## Summary

Advance Foundry's world clock (`game.time`) for the two real gaps in this module's own mechanical time-tracking: corridor traversal between rooms, and non-combat room-kind resolution (skill challenges, puzzles, traps, narrative, treasure). Combat rounds and rests are already covered by existing behavior, confirmed this session, and are explicitly **not** touched by this work. The per-room-kind time costs are agent-tunable at runtime through this module's own existing `game.modules.get(MODULE_ID).api` convention, not hardcoded constants.

## Motivation

Confirmed with the owner: the primary goal is mechanical correctness — PF2e's own time-based effects (condition/buff durations, spell durations, exploration-mode activities) should expire against real elapsed dungeon time, not never advance at all. Pacing/display is explicitly secondary and out of scope for this spec.

## Investigation findings (this session, all confirmed live against the current world unless noted)

- No existing `game.time`/`worldClock` usage anywhere in this codebase (`grep` confirmed zero hits) — this is genuinely greenfield.
- `CONFIG.time.roundTime` is `6` (confirmed live) — Foundry **core**'s own `Combat#nextRound()` already auto-advances the world clock by this amount every combat round, independent of PF2e or this module. Combat rounds need **no new code**.
- #613 (`safe_rest` rooms calling `game.pf2e.actions.restForTheNight({actors, skipDialog: true})`, confirmed current `scripts/dungeon-scene.mjs:1492`) is already merged. PF2e's own `restForTheNight` action is documented PF2e/Foundry system behavior to advance the world clock by 8 hours as part of its own built-in logic (not live-tested this session — doing so would advance the real, shared world clock with no safe way to undo it). Per the owner's own decision this session, this is trusted rather than re-verified or re-implemented; rests need **no new code** either.
- PF2e's own `worldClock` setting is already configured in this world (`dateTheme: "AR"`, `showClockButton: true`, `playersCanView: false`, `syncDarkness: false`) — the PF2e system's own native clock UI already exists. This spec calls Foundry's own `game.time.advance(seconds)` directly, which is the same primitive both Foundry core and PF2e's own clock UI already build on — world-clock sync/calendar behavior is respected automatically by construction, not a separate integration this spec needs to build.
- A PF2e actor's land speed lives at `system.movement.speeds.land.value` — **not** `system.attributes.speed`, confirmed by an existing comment in this exact codebase (`scripts/dungeon-combat.mjs:2878-2882`) documenting a prior bug where the wrong path silently returned 0 and nothing moved. This spec reuses the confirmed-correct path.
- The `foundry-rest` relay the agent service uses explicitly refuses any script containing the literal text `game.settings.set` (confirmed via this project's own `foundry-rest` skill documentation). A plain settings-based design cannot be adjusted by an agent-relayed script directly — this spec routes agent changes through a dedicated API method instead (see "Agent tunability" below), matching this module's own existing `game.modules.get(MODULE_ID).api.postAgentLoopStatus()` convention.
- This module's own corridor generator already computes real, per-edge corridor length as part of normal room building (`corridorSegments`/`corridorTilesForSegments`, extensively exercised this session across #860/#861/#873/#877) — a distance-based travel-time calculation is genuinely feasible here, not an abstraction this module would need to invent data for.

## Decisions

1. **Scope: corridor traversal + non-combat room-kind resolution only.** Combat rounds and rests are excluded — already handled by existing behavior (confirmed above), and re-implementing either here would risk double-advancing the clock.
2. **Corridor traversal time is distance-based**, using the real corridor length and the **slowest party character's own land speed** (PF2e's own stated group-travel convention), not a flat per-transition estimate and not a fixed assumed speed.
3. **Non-combat room-kind time costs are a central, extensible registry**, not per-room-kind bespoke logic scattered through the codebase — easy to add a new entry later (e.g. a downtime activity in a rest room) without restructuring anything.
4. **The registry's own values are genuinely invented** (PF2e RAW does not define "how long does resolving a skill challenge room take"), approved by the owner this session per CLAUDE.md's own "get the owner's explicit approval and record it on the issue" rule for a deviation from strict RAW:
   - `skill_challenge`, `puzzle`: 1 minute per attempt.
   - `trap`, `narrative`, `treasure`: 0 additional minutes (already covered by the corridor/room traversal time the party is already spending).
   - `combat`, `safe_rest`, `safe_entry`: not in this registry — `safe_entry` (the narrative intro room, never counted toward dungeon size per this project's own established convention) advances no time either, matching `narrative`'s own 0-minute treatment.
5. **Time-cost values are stored as a real Foundry world setting** (one JSON object covering every room kind, matching this module's own existing `movementStepDelayMs`/`followerStepDelayMs` tunable-setting convention), with the values above as defaults.
6. **The agent service adjusts these values through a new API method**, never a direct `game.settings.set` call (which the relay's own script filter refuses) — `game.modules.get(MODULE_ID).api.setRoomKindTimeCost(kind, minutes)` to write, `getRoomKindTimeCosts()` to read, both calling into the module's own already-installed code (outside what the relay's text filter ever scans).
7. **Automatic, not a GM on/off toggle.** Every qualifying room resolution advances the clock; only the per-kind *values* are tunable, not whether advancement happens at all.
8. **UI display of elapsed time is out of scope for this spec**, per the owner's own explicit decision this session — a separate future issue if wanted.

## Architecture

A new module, `scripts/game-clock.mjs`, owns:

- `advanceGameTime(seconds)` — a thin, GM-only wrapper around `game.time.advance(seconds)`, matching this module's own existing convention of gating every world-mutating call on `game.user.isGM`/`game.users.activeGM.isSelf` (confirmed pattern throughout `dungeon-combat.mjs`/`dungeon-scene.mjs`).
- `ROOM_KIND_TIME_COST_DEFAULTS` — the plain object `{skill_challenge: 1, puzzle: 1, trap: 0, narrative: 0, treasure: 0}` (minutes per attempt/resolution), registered as a world setting's own default value.
- `minutesForRoomResolution(kind, { attempts = 1 } = {})` — pure, reads the current setting (falling back to the defaults above), returns `0` for any kind not in the registry (combat, safe_rest, safe_entry, and any future kind this spec didn't anticipate — fail safe to "advance nothing" rather than throw).
- `feetToMinutesAtSlowestSpeed(feet, partyMembers)` — pure, given a corridor's own real length in feet and the party's character actors, computes `feet / (minSpeed * 10)` minutes, using PF2e's own Travel-speed convention (Speed × 10 feet per minute at a normal explore pace) and `system.movement.speeds.land.value` (confirmed-correct path) for each character's own speed, taking the minimum. Falls back to a documented default speed (25 ft, PF2e's own common baseline) if a party has no characters with a readable speed, rather than dividing by zero.

### Corridor traversal integration

Corridor length (in feet) is computed once, at room-build time, from the edge's own real `corridorSegments` — the same data this session's own #860/#861/#873/#877 work already reads — and persisted onto the **destination** room's own existing per-room state bucket (`state.rooms[roomId]`, confirmed current via #820's own investigation this session) as a new field, e.g. `state.rooms[roomId].corridorLengthFeet`. `handleDungeonDoorOpened` (the confirmed current entry point for a room transition, `scripts/dungeon-scene.mjs`) reads this field back when that room's own reveal door opens and calls `advanceGameTime(feetToMinutesAtSlowestSpeed(...) * 60)`.

### Room-kind resolution integration

Wherever a `skill_challenge`/`puzzle`/`trap`/`narrative`/`treasure` room's own outcome resolves (the same integration points #613/#617 already used — confirmed current room-resolution code in `scripts/dungeon-scene.mjs`/`scripts/ui/dungeon-app.mjs`), call `advanceGameTime(minutesForRoomResolution(kind, {attempts}) * 60)` once resolution completes. `attempts` comes from whatever count that room kind's own existing state already tracks (Victory Point attempt counts for skill challenges, stage attempt counts for puzzles).

### Agent tunability

`scripts/module.mjs`'s own existing `api` object (confirmed current, already exposes `postAgentLoopStatus`) gains two new methods: `setRoomKindTimeCost(kind, minutes)` (validates `kind` is a real registry key and `minutes` is a non-negative number, then calls `game.settings.set` on the module's own setting) and `getRoomKindTimeCosts()` (returns the current merged setting-plus-defaults object). Both are plain functions in the module's own already-installed code — the agent service calls them via a short, filter-safe relayed script (`game.modules.get(MODULE_ID).api.setRoomKindTimeCost("puzzle", 2)`), never touching `game.settings.set` in the relayed text itself.

## Error handling

- `advanceGameTime` is a no-op (not a throw) if `game.time?.advance` is unavailable for any reason — this module's own established convention (confirmed throughout `scripts/foundry-api.mjs`) is to degrade gracefully rather than block dungeon progression over a missing/changed Foundry API.
- `feetToMinutesAtSlowestSpeed` with an empty or speed-less party falls back to a documented default (25 ft/round) rather than producing `Infinity`/`NaN`.
- `minutesForRoomResolution` returns `0` (never throws) for an unrecognized room kind — a future room kind added elsewhere in this codebase without a corresponding registry entry costs no time rather than crashing room resolution.

## Testing considerations

- `minutesForRoomResolution`/`feetToMinutesAtSlowestSpeed`/the registry-merge logic are all pure and fully unit-testable without any live Foundry world.
- `advanceGameTime`'s own GM-gating and its call to `game.time.advance` need a mocked `game`/`game.time` global, matching this codebase's own established Foundry-stub test conventions.
- The corridor-length persistence (build-time write, door-open-time read) needs a test exercising the real scene-build pipeline, matching the existing `tests/dungeon-corridor-*.test.mjs` sweep-test conventions this session has used extensively.
- The new `setRoomKindTimeCost`/`getRoomKindTimeCosts` API methods need direct unit tests (invalid kind, negative minutes, valid round-trip).

## Explicitly out of scope

- Combat round time advancement (already handled by Foundry core).
- Rest time advancement (already handled by `restForTheNight`, #613).
- Any UI display of elapsed dungeon time, in the tracker or elsewhere (a separate future issue, per the owner's own decision this session).
- A GM-facing on/off toggle for whether time advances at all (this spec is always-on; only the per-kind values are tunable).
- Re-verifying live whether `restForTheNight` genuinely advances the world clock by 8 hours as documented PF2e behavior (deliberately not tested this session to avoid an irreversible side effect on the real shared world clock) — accepted on the strength of documented system behavior per the owner's own decision, not re-litigated here.

## Open questions

None remaining — every decision point the original issue raised was resolved during this session's own conversational design (see "Decisions" above).
