# Player-Visible Room Description Popup for Puzzle, Skill-Challenge and Narrative Rooms

**Issue:** #1267 — show the player-visible description in a popup for puzzle, skill-challenge and narrative rooms.

**Builds on:** #611 / #623 (interactable room-feature tokens, `docs/superpowers/specs/2026-10-05-interactable-room-feature-tokens-design.md`), #822 (the attempt dialogs opened by a token click, `scripts/room-feature-check.mjs`), #49 (`playerDescription` on puzzles and its customization), #167 / #165 (narrative room state and archetypes), #38 (the GM-only summary boundary), #1252/#1254-style socket relays (`scripts/dungeon-remote.mjs`).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

When players reach a puzzle, skill-challenge or narrative room, nothing shows them the in-fiction description of what they are looking at. This spec adds that text at the moment it matters:

- **Puzzle and skill-challenge rooms:** the description appears **at the top of the existing attempt dialog** that opens when a player interacts with the room's tile (the #822 dialogs), every time they interact. The first time the tile is used in a room, the description is also **shown to every other connected user** in a read-only popup and posted once as a **chat card**.
- **Narrative rooms:** on first entry the description is shown to **everyone** as a read-only popup and posted once as a chat card. There is no attempt form; Continue stays in the tracker.

To make this possible, skill-challenge and narrative setpieces gain a real player-safe `playerDescription` field. Today only puzzles have one.

## Investigation findings

- **The ticket's premise is partly wrong.** `playerDescription` exists only on puzzle setpieces (7 in `data/dungeon-setpieces.json`). The 5 skill-challenge templates carry `summary`, `specialtySkills` and `skillFlavor`; the 8 narrative templates carry `summary`, `revealText`, and archetype fields (`npcName`, `npcHook`, `options`, `suggestedObjective`). Treasure (5) and trap (3) are out of scope; trap already has `playerDescription`.
- **`summary` is not safe to show.** For puzzles the tracker treats `summary` as GM-only because it describes the solution (`scripts/ui/dungeon-app.mjs` ~1359-1394). For skill-challenge and narrative rooms `summary` is a GM-facing synopsis, so reusing it risks leaking mechanics. A dedicated field avoids auditing every template's wording.
- **A popup already exists for puzzles and challenges.** `handleRoomFeatureClick` (`scripts/room-feature-check.mjs`) runs on the interacting player's client: it reveals the feature (GM runs it directly, a player relays `roomFeatureInteract`), then opens `promptPuzzleStage` (`scripts/ui/puzzle-stage-dialog.mjs`) or `promptSkillChallenge` (`scripts/ui/skill-challenge-dialog.mjs`), both `DialogV2.wait`. Those dialogs show only the character and stage/skill pickers. They are the natural home for the description.
- **The tile trigger is per-user.** `triggerRoomFeatureToken` (`scripts/module.mjs` ~426) fires on the targeting user's own client only (`userId === game.user.id`), so "show to everyone" needs a broadcast.
- **Narrative rooms have no tile.** `handleDungeonDoorOpened` (`scripts/dungeon-scene.mjs` ~2395-2480) reveals tokens, calls `advanceToRoom`, focuses the camera and returns. Nothing is shown. A retreat and re-entry runs through the `revisit` branch (`retreatVersion >= 1`), which deliberately does not re-trigger room effects (#439).
- **Persisted state to hang a "shown" flag on.** `room.puzzle`, `room.challenge` and `room.narrative` are per-room persisted objects (`ensurePuzzleState`, `ensureSkillChallenge`, `ensureNarrativeState` in `scripts/dungeon-runner.mjs`). The customization agent rewrites their display fields (`applyPuzzleCustomization`, `applySkillChallengeCustomization`, `applyNarrativeCustomization`).
- **Sockets.** `scripts/dungeon-remote.mjs` already registers a `module.pf2e-dungeon-crawl` socket with a GM-executed `DUNGEON_ACTIONS` table and acks; `scripts/combatant-write-relay.mjs` shows the one-way message pattern.

## Resolved decisions

1. **Source of text:** add a `playerDescription` field to **skill-challenge and narrative** setpieces, authored for every existing template and settable by the customization agent, exactly as puzzles already work.
2. **Delivery:** a popup **plus a chat card**. The chat card persists so the text can be re-read; the popup is the moment-of-interaction presentation.
3. **Audience and frequency:** the **first** time the room's description is presented, **everyone** sees it. On **subsequent interactions** only the **interacting player** sees it.
4. **Relationship to the attempt UI:** **integrated** into the existing puzzle/skill-check dialogs (#822). The popup *is* the attempt dialog with the description on top; the tracker sidebar form stays as a fallback.
5. **Narrative rooms:** a **read-only** popup plus chat card on first entry. No Continue button in the popup.
6. **No stalls:** the broadcast popups are never awaited by game logic; AI and GM-less flows are unchanged and read the description from the chat card.

## Design

### Data: `playerDescription` on skill challenges and narratives

- **Templates (`data/dungeon-setpieces.json`).** Add `playerDescription` (2-4 sentences, in-fiction, second-person or scene-setting, no mechanics, DCs, skill names, or solutions) to all 5 skill-challenge and all 8 narrative templates. Narrative text must not duplicate `revealText` (which is the lore the party *learns*), only describe what the party *sees on entering*.
- **Validity.** `isValidNarrativeTemplate` (`scripts/narrative-mechanics.mjs`) stays unchanged for the existing required fields; `playerDescription` is optional at the validity level (a template without one simply shows no popup) so older custom templates keep working. A unit test asserts every shipped template of the three kinds has a non-empty `playerDescription`.
- **State.** `ensureSkillChallenge` / `ensureNarrativeState` copy `playerDescription` into `room.challenge` / `room.narrative` (as `ensurePuzzleState` already does for puzzles). Each state object also gains `descriptionShown: false`.
- **Customization.** `applySkillChallengeCustomization` and `applyNarrativeCustomization` accept an optional `playerDescription` (string, trimmed, non-empty, max 600 chars) and prefer it over the template's, mirroring `applyPuzzleCustomization`. The pending-customization read functions (`getPendingSkillChallengeCustomization`, `getPendingNarrativeCustomization`) return the current `playerDescription` as context. The `tools/agent-loop` customization prompt and response schema for those two kinds add the field with the instruction "player-visible only; never mention DCs, skills, successes, or solutions".
- **Display source.** One pure helper, `roomPlayerDescription(room)`, returns the persisted `puzzle.playerDescription`, `challenge.playerDescription` or `narrative.playerDescription` for the room's kind, falling back to the raw setpiece's, else `null`. It never returns `summary`. The tracker's setpiece block (`dungeon-app.mjs` ~1391) is switched to this helper so tracker and popup cannot diverge.

### Presentation module: `scripts/room-description.mjs`

Foundry-free pure parts plus a thin glue layer, in the style of `room-feature-check.mjs`.

- `buildRoomDescriptionCard({ roomName, kindLabel, description })` returns the escaped HTML for the chat card (title, kind, text). All dynamic text is HTML-escaped.
- `planDescriptionPresentation({ state, roomId, kind, trigger, interactingUserId })` is pure and returns:
  - `{ show: false }` when the room has no description, the run is completed, or the room is not the current room;
  - otherwise `{ show: true, first: boolean, audience }` where `first` is `!descriptionShown` and `audience` is `"everyone"` when `first`, else `"interactor"`. For a narrative room, `trigger` is `"entry"`; for puzzle/challenge, `"interact"`.
- `markDescriptionShown(sceneId, roomId, kind)` (in `dungeon-runner.mjs`, GM-side, idempotent) sets `descriptionShown: true` and returns whether this call was the one that flipped it. Only the winning call posts the chat card and broadcasts. This makes the first-time broadcast exactly-once even if two players target the tile at once or the door handler fires twice.

### Puzzle and skill-challenge flow

1. A player targets the tile. `handleRoomFeatureClick` reveals the feature (unchanged).
2. As part of the authoritative GM-side reveal (the `roomFeatureInteract` relay handler, or the direct path when the interacting user is the GM), `runRoomFeatureAction` calls `markDescriptionShown` after `revealRoomFeature` succeeds. The call that flips the flag posts the **chat card** (public `ChatMessage.create`) and emits a **`roomDescription` socket message** `{ type: "roomDescription", sceneId, roomId, kind, exceptUserId }` to all other users.
3. The interacting client opens the existing attempt dialog with the description rendered as a paragraph block above the pickers. This happens on **every** interaction, so the "subsequent interactions, interacting player only" rule is satisfied by the dialog alone with no extra broadcast.
4. Each receiving client handles `roomDescription` by opening a **read-only** `DialogV2` popup (title: room name; body: the description; one **Close** button), unless `exceptUserId` is its own id. It is a plain `render`, never `wait`, and not awaited by anything. It reads the description from local run state (`roomPlayerDescription`), not from the message, so a stale or forged message cannot inject text.
5. The `promptPuzzleStage` and `promptSkillChallenge` helpers gain an optional `description` argument. `promptRoomFeatureCheck` passes `roomPlayerDescription(room)`. The `buildPuzzleStageChoices` shape is unchanged; the description is separate.

The description is shown even when there is nothing left to attempt (resolved or all stages attempted): in that case `promptRoomFeatureCheck` keeps its existing notification, and the description is not re-shown (the dialog does not open). This avoids a description-only popup that has no action behind it.

### Narrative flow

1. `handleDungeonDoorOpened` already runs `advanceToRoom` for a first entry. After a successful advance, for `room.kind === "narrative"`, it calls `markDescriptionShown`. The winning call posts the **chat card** and sends the **`roomDescription` socket message** with no `exceptUserId`, and the entering client opens the same read-only popup locally.
2. A **re-entry** after a retreat (the `revisit` branch) does not re-present (`descriptionShown` is already true). There is no interaction target in a narrative room, so "subsequent interactions" has no additional case; the chat card and the tracker keep the text available.
3. The "first room is a narrative intro" rule is unaffected: the room-entry safe room is `safe_entry`, not `narrative`, so it never triggers this path. If a future change makes the entry room a narrative, it simply gets this popup.

### No-stall guarantees (GM-less runs and AI parties)

- The broadcast popup is fire-and-forget (`render`, not `wait`). No game logic awaits it, so a client that never closes it, or that has no human at all, cannot hold anything up.
- AI-controlled parties and GM-less runs keep using the existing reveal and attempt code paths (`attemptPuzzleStageFor`, `attemptSkillChallengeFor`) which do not involve dialogs. They receive the description as the chat card, which is where the AI history and any agent reading chat can see it.
- `markDescriptionShown` runs wherever the reveal already runs (GM client, or the GM-side relay handler). In a run with no GM client, the existing host-driven path is unchanged and the description simply is not broadcast; the interacting player still sees it in their own attempt dialog.
- All failures (chat post, socket emit, render) are caught and logged; none can fail a reveal, an entry or an attempt.

### Settings

None. The behavior is on by default. A room with no `playerDescription` produces no popup and no card.

### Localization

New keys in `lang/en.json` under `PF2EDC.Dungeon.RoomDescription`: `Title` (`{room}`), `Close`, `CardHeading` (`{room}`), and the kind labels reuse `ROOM_KIND_KEYS`.

## Error handling

- Missing or empty `playerDescription` is not an error: nothing is shown and nothing is posted.
- A `roomDescription` message for a room that is not the local current room, or for a completed run, is ignored.
- A user with the tracker or another popup already open still gets the popup; Foundry stacks `DialogV2` windows.
- A non-GM user cannot cause a broadcast directly. The message is emitted by whichever client executes `markDescriptionShown` after the authoritative `planRoomFeatureAction` passes, and receivers re-read local state.

## Testing

- **`roomPlayerDescription` (pure):** per kind, persisted overrides template, never returns `summary`, `null` when absent.
- **`planDescriptionPresentation` (pure):** first versus subsequent, audience values, no description, completed run, non-current room, narrative `entry` trigger.
- **`markDescriptionShown`:** flips once, returns true only for the winning call, idempotent, no-op when the room has no state or description.
- **Card builder:** HTML escaping of name and description, kind label.
- **Template data guard:** every shipped puzzle, skill-challenge and narrative template has a non-empty `playerDescription`, and none contains a digit-DC pattern, the word "DC", or a skill-challenge `specialtySkills` name (a coarse leak check).
- **Customization:** `applySkillChallengeCustomization` and `applyNarrativeCustomization` accept, trim and cap `playerDescription`; absent value keeps the template's; pending-read functions return it.
- **Dialog wiring:** `promptRoomFeatureCheck` passes the description to the prompts; no description when nothing is attemptable (existing notification path unchanged).
- **Narrative entry:** first entry posts the card and emits the broadcast once; a retreat and re-entry does not repeat it; non-narrative rooms are untouched.
- **Broadcast receiver:** ignores wrong scene/room, ignores `exceptUserId` self, reads text from local state.
- **Regression:** #822 attempt flows, the #439 revisit branch, and the tracker's displayed `playerDescription` for puzzles and traps are unchanged.
- **Live verification:** with two connected users, user A targets a puzzle tile: a chat card appears once, user B gets a read-only popup, user A gets the attempt dialog with the description; a second interaction shows the description only in A's dialog. Skill challenge likewise. Entering a narrative room shows everyone the popup once; retreating and re-entering does not repeat it. With an AI party and no human at the tile, nothing blocks and the chat card is present.

## Explicitly out of scope

- Treasure and trap rooms (trap already has a `playerDescription`; treasure was not requested).
- Making the narrative popup an action surface (Continue, options, NPC hook). Those stay in the tracker.
- Requiring the tile to be used before the room can be left (#740).
- Per-user opt-out settings for the popup.

## Open questions

None blocking. Left to planning: the exact wording of the 13 authored descriptions, and whether the read-only popup should reuse an existing Application class or a plain `DialogV2` (the spec assumes `DialogV2`, matching the other dialogs in `scripts/ui/`).
