# Room Description Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the player-visible, in-fiction room description for puzzle, skill-challenge and narrative rooms: inside the attempt dialog on every interaction, and — the first time only — as a read-only popup for everyone plus one chat card (#1267).

**Architecture:** Skill-challenge and narrative setpieces gain a real `playerDescription` (authored for all 13 templates, copied into persisted room state, settable by the customization agent). A pure helper `roomPlayerDescription(room)` is the single display source (tracker + popup). A new `scripts/room-description.mjs` holds the pure card builder / presentation planner and the Foundry glue (`presentRoomDescription`, a `roomDescription` socket receiver). `markDescriptionShown` (GM-side, in `dungeon-runner.mjs`) makes the first-time broadcast exactly-once. The existing #822 attempt dialogs get an optional `description` block; narrative rooms present on first entry from `handleDungeonDoorOpened`.

**Tech Stack:** Foundry VTT v13 module, ES modules, `DialogV2`, module socket `module.pf2e-dungeon-crawl`, Vitest, Ajv schema validation (`npm run validate:dungeon`).

**Spec:** `docs/superpowers/specs/2026-10-10-room-description-popup-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json` `version` (currently `0.95.7`; this is a feature → decide minor vs patch with the owner's convention, re-read `origin/main` at merge time, never reuse a number).
- Run the `update-architecture-docs` skill in the same pass (new `scripts/room-description.mjs` and new imports in `module.mjs`, `dungeon-scene.mjs`, `dungeon-remote.mjs`, `ui/dungeon-app.mjs`).
- `summary` is NEVER shown to players (GM-only synopsis); only `playerDescription`.
- `playerDescription` is 2-4 sentences, in-fiction, no mechanics, DCs, skill names or solutions; narrative text must not duplicate `revealText`; customization cap 600 chars, trimmed, non-empty.
- Broadcast popups are `render`, never `wait`; nothing awaits them; every failure (chat, socket, render) is caught and logged and can never fail a reveal, an entry or an attempt.
- Treasure and trap rooms are out of scope; no settings are added.
- Worktree off `origin/main`; `npm ci`; copy `.env` before live testing.

## Review Focus

- A custom/legacy template with no `playerDescription` → no popup, no card, no error (optional at the validity level).
- Two players target the tile at once, or the door handler fires twice → exactly one chat card and one broadcast (`markDescriptionShown` is synchronous-claim idempotent).
- Retreat then re-enter a narrative room (`revisit` branch) → no repeat; completed run or not-current room → ignored.
- A forged/stale `roomDescription` socket message must not inject text: the receiver renders only local `roomPlayerDescription(room)`.
- HTML in a customized description or room name is escaped in the card, popup and dialog.
- AI/GM-less flows: nothing blocks if no human closes the popup; the interactor-less (AI) path still produces the chat card.

## File Structure

| File | Responsibility |
|---|---|
| `data/dungeon-setpieces.json` | `playerDescription` on 5 skill-challenge + 8 narrative templates. |
| `data/schema/dungeon-setpieces.schema.json` | (already allows `playerDescription`; confirm) |
| `scripts/skill-challenge-mechanics.mjs` | `initSkillChallengeState` copies `playerDescription`, `descriptionShown:false`. |
| `scripts/dungeon-runner.mjs` | `ensureNarrativeState`/`applySkillChallengeCustomization`/`applyNarrativeCustomization`/pending reads; `roomPlayerDescription`; `markDescriptionShown`. |
| `tools/agent-service/customization-generator.mjs` | Schema + prompt gain `playerDescription` for skill_challenge and narrative. |
| `scripts/room-description.mjs` (new) | Pure `buildRoomDescriptionCard`, `planDescriptionPresentation`; glue `presentRoomDescription`, `showRoomDescriptionPopup`, `registerRoomDescriptionSocket`. |
| `scripts/ui/puzzle-stage-dialog.mjs`, `scripts/ui/skill-challenge-dialog.mjs`, `scripts/room-feature-check.mjs` | Description block above the pickers. |
| `scripts/room-feature-tokens.mjs`, `scripts/module.mjs`, `scripts/dungeon-remote.mjs`, `scripts/ui/dungeon-app.mjs` | `presentDescription` dep wired into `runRoomFeatureAction` callers. |
| `scripts/dungeon-scene.mjs` | Narrative first-entry presentation in `handleDungeonDoorOpened`. |
| `lang/en.json` | `PF2EDC.Dungeon.RoomDescription.*`. |

---

### Task 1: Author the 13 descriptions + data guard

**Files:**
- Modify: `data/dungeon-setpieces.json` (add `"playerDescription"` to each entry below)
- Test: `tests/room-description-data.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const setpieces = JSON.parse(readFileSync(new URL("../data/dungeon-setpieces.json", import.meta.url), "utf8"));
const KINDS = ["puzzle", "skill_challenge", "narrative"];
const SKILL_WORDS = ["acrobatics","arcana","athletics","crafting","deception","diplomacy","intimidation","medicine","nature","occultism","performance","religion","society","stealth","survival","thievery"];

describe("#1267 playerDescription on shipped templates", () => {
  const rows = setpieces.filter((s) => KINDS.includes(s.kind));
  it("covers 7 puzzles, 5 skill challenges and 8 narratives", () => {
    expect(rows.filter((s) => s.kind === "puzzle")).toHaveLength(7);
    expect(rows.filter((s) => s.kind === "skill_challenge")).toHaveLength(5);
    expect(rows.filter((s) => s.kind === "narrative")).toHaveLength(8);
  });
  it.each(rows.map((s) => [s.id, s]))("%s has a clean player-safe playerDescription", (_id, s) => {
    const d = s.playerDescription;
    expect(typeof d).toBe("string");
    expect(d.trim().length).toBeGreaterThan(40);
    expect(d.length).toBeLessThanOrEqual(600);
    expect(d).not.toMatch(/\bDC\b|\bDC\s*\d|\d+\s*DC\b/i);
    for (const w of SKILL_WORDS) expect(d.toLowerCase(), `${s.id} leaks "${w}"`).not.toMatch(new RegExp(`\\b${w}\\b`));
    expect(d).not.toBe(s.summary);
    if (s.revealText) expect(d).not.toContain(s.revealText.slice(0, 40));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/room-description-data.test.mjs` → FAIL (undefined descriptions).
- [ ] **Step 3: Add these exact strings** (each as `"playerDescription"` on the entry with the given id; the 7 puzzles already have one — leave them):

| id | playerDescription |
|---|---|
| the_collapsing_span | A narrow bridge of rope and sun-bleached planks sags over a dark chasm. Somewhere ahead a cable gives with a sharp crack, and the whole span shudders beneath your feet. |
| a_council_divided | Three groups of locals crowd the hall, each huddled apart and glaring at the others across a long table. Voices rise the moment you step in, and every eye turns to see whose side you will take. |
| the_sealed_archive | Rows of iron-banded shelves reach into the dim, stacked with brittle ledgers and curling scrolls. Faded wards hum faintly across the doors, and the margins are crowded with cramped, half-faded notes. |
| past_the_watch | Lantern light sweeps slowly across a long, open chamber. Shapes move at its far end, and every corner seems to have someone, or something, keeping a careful eye on it. |
| the_shifting_floor | The flagstones beneath you groan and tilt, and cold water seeps up through the cracks. Whole sections of floor slide away and settle again, as though the room itself were restless. |
| the_last_wardens_oath | A guardpost lies half-buried under fallen stone. A cracked badge of office rests on a tilted desk beside a battered journal, and the dust around them has long since settled. |
| echoes_of_the_first_seal | A great mural spans the far wall, its colors dulled but its figures still crisp. Rows of robed workers file toward a vast shape at the center, though more than one patch has been scraped or painted over. |
| the_bound_familiar | In the middle of the floor, a ring of scratched sigils glows weakly. Inside it a small, thin creature curls in on itself, watching you with wide, hopeful eyes. |
| the_wandering_cartographer | A lean figure crouches over a spread of stained parchment by a smoldering fire, sketching with a stub of charcoal. They look up warily as you enter, one hand never leaving the edge of the map. |
| the_starving_prisoner | Behind a rusted grate, a gaunt figure sits slumped against the cell wall. Chains hang loose from one wrist, and a thin voice asks, barely audible, whether you are real. |
| the_desecrated_shrine | A small stone shrine stands in an alcove, its carvings gouged and its offering bowl overturned. Fresh scratches cut across the sacred symbols, yet candles and coins still lie scattered at its foot. |
| the_missing_relic | A scorched satchel of notes lies spilled across an old table, the ink smeared and the edges curled by flame. Muddy boot prints lead away from it and deeper into the dark. |
| the_sealed_door_beyond | Deep markings climb a towering wall toward a vast door sealed with heavy bars. Cold air seeps from its seams, and something behind it seems to wait. |

(The narrative texts describe what is seen on entering and do not repeat `revealText`; no mechanics, DCs or skill words.)

- [ ] **Step 4:** `npx vitest run tests/room-description-data.test.mjs` → PASS; `npm run validate:dungeon` → OK.
- [ ] **Step 5: Commit** — `git add data/dungeon-setpieces.json tests/room-description-data.test.mjs && git commit -m "#1267: author playerDescription for skill-challenge and narrative templates"`

### Task 2: Persisted state, customization, display helper, shown-flag

**Files:**
- Modify: `scripts/skill-challenge-mechanics.mjs:285-307` (`initSkillChallengeState`), `scripts/dungeon-runner.mjs` (`ensureNarrativeState` ~1159, `getPendingSkillChallengeCustomization` ~681, `applySkillChallengeCustomization` ~716, `getPendingNarrativeCustomization` ~1223, `applyNarrativeCustomization` ~1265; `ensurePuzzleState`'s `initPuzzleState` call is unchanged but must also yield `descriptionShown:false` — add it in `initPuzzleState` in `scripts/puzzle-mechanics.mjs`)
- Modify: `scripts/ui/dungeon-app.mjs:1391-1395` (use the helper)
- Test: `tests/room-description-state.test.mjs`

**Interfaces:**
- Produces:
  - `cleanPlayerDescription(v) → string|null` (exported from `dungeon-runner.mjs`): trims, `null` for non-string/empty, truncates to 600 chars.
  - `roomPlayerDescription(room, setpiece = null) → string|null` (exported from `dungeon-runner.mjs`): by `room.kind`: `puzzle`→`room.puzzle?.playerDescription`, `skill_challenge`→`room.challenge?.playerDescription`, `narrative`→`room.narrative?.playerDescription`; falls back to `setpiece?.playerDescription`; non-empty trimmed string else `null`. Never reads `summary`.
  - `markDescriptionShown(sceneId, roomId, kind, { settingsRef }?) → Promise<boolean>`: `true` only for the single call that flipped `descriptionShown` false→true on `room.puzzle|challenge|narrative` (keys per `{puzzle:"puzzle", skill_challenge:"challenge", narrative:"narrative"}`); `false` when no run/room/state, no `playerDescription`, or already shown. A module-level `Set` of `"<sceneId>:<roomId>:<kind>"` claims is added **synchronously before any await**, so two concurrent callers cannot both win; the claim is released if persisting throws.
  - State objects `room.puzzle`, `room.challenge`, `room.narrative` carry `playerDescription` and `descriptionShown: false` from creation.
  - `apply*Customization` accept `playerDescription` (cleaned; absent keeps existing); pending reads return `playerDescription`.

- [ ] **Step 1: Write failing tests** (use the in-memory `settingsRef` pattern from `tests/dungeon-runner.test.mjs` — read its setup for `settingsRef`/`getRunState` fakes first):
  - `initSkillChallengeState({ template: {…, playerDescription: "X"} })` → `playerDescription: "X"`, `descriptionShown: false`; no template → `playerDescription: null`.
  - `ensureNarrativeState` copies `setpiece.playerDescription` (or `null`) and sets `descriptionShown:false`.
  - `applySkillChallengeCustomization(.., { playerDescription: "  New text  " })` → `"New text"`; 700-char input → 600 chars; `""`/whitespace/non-string → keeps template's; same for `applyNarrativeCustomization`.
  - `getPending*Customization` include `playerDescription`.
  - `roomPlayerDescription`: persisted overrides setpiece; each of the three kinds; `null` when absent/blank; **never returns `summary`** (room with only `summary` → `null`).
  - `markDescriptionShown`: first call `true`, second `false`; two calls via `Promise.all` → exactly one `true`; room with no `playerDescription` → `false` and flag stays unset; unknown room/run → `false`; persist throwing releases the claim so a retry can win.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement** per the interfaces. In `initSkillChallengeState` add `playerDescription: valid ? (template.playerDescription ?? null) : null, descriptionShown: false`; in `initPuzzleState` add `descriptionShown: false`; `ensureNarrativeState` gets the two fields; `dungeon-app.mjs` ~1391 becomes `playerDescription: roomPlayerDescription(currentRoom, setpiece) ?? trap?.description ?? null` (trap still feeds from `trap.description`; verify variable names on the spot — `puzzle`, `narrative`, `trap`, `setpiece` are already in scope there).
- [ ] **Step 4: Run** `npx vitest run tests/room-description-state.test.mjs tests/dungeon-runner.test.mjs tests/skill-challenge-mechanics.test.mjs tests/puzzle-mechanics.test.mjs` then `npm test` → PASS (existing deep-equality assertions on these state shapes may need the two new fields added; update them, don't loosen).
- [ ] **Step 5: Commit** — `git commit -am "#1267: playerDescription state, helper and shown-flag"`

### Task 3: Customization agent schema and prompt

**Files:**
- Modify: `tools/agent-service/customization-generator.mjs` (schemas ~12-45; `TOOL_DESCRIPTIONS` ~79; add a `skill_challenge` entry)
- Test: `tests/agent-service-customization-generator.test.mjs`

- [ ] **Step 1: Failing test** additions: the `skill_challenge` and `narrative` response schemas list `playerDescription` in `properties` (string) and in `required` for `skill_challenge`? **No** — keep it optional for both so a model that omits it still applies; assert it is in `properties` and NOT in `required`; assert the tool description for both kinds contains the phrase `player-visible only; never mention DCs, skills, successes, or solutions`; assert `fulfillPendingCustomizations` passes `playerDescription` through to the apply functions (`tests/dungeon-customization-fulfillment.test.mjs` pattern: result object reaches `applySkillChallengeCustomization` unchanged).
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement** (add `playerDescription: { type: "string" }` to both schemas; extend `TOOL_DESCRIPTIONS.narrative` and add `TOOL_DESCRIPTIONS.skill_challenge` = `'Write flavor text for a Pathfinder 2e dungeon skill challenge. Never invent mechanics — only name/summary/skillFlavor/playerDescription. playerDescription: 2-4 sentences describing what the party sees on arriving; player-visible only; never mention DCs, skills, successes, or solutions.'`; narrative's gains the same sentence).
- [ ] **Step 4:** run the two test files + `npm test` → PASS. **Step 5: Commit** — `git commit -am "#1267: customization agent supplies playerDescription"`

### Task 4: Presentation module (`room-description.mjs`)

**Files:**
- Create: `scripts/room-description.mjs`
- Modify: `lang/en.json` (`PF2EDC.Dungeon.RoomDescription.Title` = `"{room}"`, `.Close` = `"Close"`, `.CardHeading` = `"{room}"`)
- Test: `tests/room-description.test.mjs`

**Interfaces:**
- Consumes: `roomPlayerDescription`, `markDescriptionShown` (Task 2). `SOCKET` from `scripts/player-choice.mjs`.
- Produces:
  - `escapeHtml(s)` (local, no Foundry dependency).
  - `buildRoomDescriptionCard({ roomName, kindLabel, description }) → string` — `<div class="pf2edc-chat pf2edc-room-description"><h3>{roomName}</h3><p class="pf2edc-room-description__kind">{kindLabel}</p><p>{description}</p></div>`, all dynamic text escaped, newlines in the description → `<br>`.
  - `planDescriptionPresentation({ state, roomId, kind, trigger }) → { show:false } | { show:true, first:boolean, audience:"everyone"|"interactor" }`: `show:false` when `state` missing, `state.completed`, `roomId !== state.currentRoomId`, room missing or `room.kind !== kind`, or no `roomPlayerDescription`; `first = !(room.<stateKey>.descriptionShown)`; `audience = first ? "everyone" : "interactor"`. `trigger` is `"entry"` (narrative) or `"interact"`; for `"entry"` on a non-first presentation return `{ show:false }` (no re-presentation).
  - `presentRoomDescription({ sceneId, roomId, kind, interactorUserId = null }, deps = {}) → Promise<boolean>` (deps default to Foundry globals: `getRunState`, `markDescriptionShown`, `postChat`, `emit`, `showPopup`, `userId`, `localize`, `kindLabel`): re-reads state, `plan = planDescriptionPresentation(…trigger = kind==="narrative"?"entry":"interact")`; if `!plan.show || !plan.first` return `false`; `won = await markDescriptionShown(...)`; if `!won` return `false`; then, each in its own try/catch: post the chat card (public `ChatMessage.create`), `emit(SOCKET, { type:"roomDescription", sceneId, roomId, kind, exceptUserId: interactorUserId })`, and — when `userId !== interactorUserId` — `showPopup({ sceneId, roomId, kind })` locally. Returns `true`.
  - `showRoomDescriptionPopup({ sceneId, roomId, kind }, deps)` — re-reads local state, applies `planDescriptionPresentation` ignoring the `first` check (`show` must be true), and renders `DialogV2` (not awaited: call `new DialogV2({...}).render({ force: true })`) with title `RoomDescription.Title`, escaped body, a single **Close** button. Never throws.
  - `registerRoomDescriptionSocket()` — `game.socket.on(SOCKET, msg => …)`: ignore unless `msg?.type === "roomDescription"`; ignore when `msg.exceptUserId === game.user.id`; call `showRoomDescriptionPopup` with only `{sceneId, roomId, kind}` (no text from the message).

- [ ] **Step 1: Write failing tests** with injected deps: card escaping (`<b>` in name/description, `&`), kind label, newline→`<br>`; planner matrix (no description, completed, not current, wrong kind, first/subsequent, narrative re-entry `show:false`); `presentRoomDescription`: winner posts one chat + one emit + one local popup; loser (`markDescriptionShown` → false) does none; `interactorUserId === userId` skips local popup; chat throwing still emits and popups (each step isolated); returns `false` when plan says no; receiver ignores wrong type, own `exceptUserId`, and never passes message text to the popup (assert `showPopup` args are exactly `{sceneId, roomId, kind}`).
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** — `git add scripts/room-description.mjs lang/en.json tests/room-description.test.mjs && git commit -m "#1267: room description presentation module"`

### Task 5: Description inside the attempt dialogs

**Files:**
- Modify: `scripts/ui/puzzle-stage-dialog.mjs` (`promptPuzzleStage(stages, characters, description = null)`), `scripts/ui/skill-challenge-dialog.mjs` (`promptSkillChallenge(specialtySkills, characters, description = null)`), `scripts/room-feature-check.mjs` (`promptRoomFeatureCheck` passes `describe(room)`), `scripts/module.mjs` (inject `roomDescription: (room) => roomPlayerDescription(room)`)
- Test: `tests/room-feature-check.test.mjs` (extend), `tests/room-description-dialog.test.mjs`

**Interfaces:**
- Produces: `descriptionBlockHtml(description, esc) → string` exported from a tiny shared helper in `scripts/room-description.mjs` (returns `""` for falsy, else `<p class="pf2edc-room-description__text">…</p>` escaped, newlines → `<br>`); the two dialogs prepend it inside `<form>`. `promptRoomFeatureCheck` deps gain optional `roomDescription = () => null`; it calls `promptPuzzleStage(stages, characters, roomDescription(room))` / `promptSkillChallenge(skills, characters, roomDescription(room))`. Existing early-return notification paths (no characters, nothing to attempt) are untouched and do **not** show the description.

- [ ] **Step 1: Failing tests:** `promptRoomFeatureCheck` passes the description (third arg) for both kinds; passes `null` when absent; with nothing to attempt it still only notifies and does not call the prompt; `descriptionBlockHtml` escapes, handles `null`, converts newlines.
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement** (dialogs: `content: \`<form>${descriptionBlockHtml(description, esc)} …existing…\``). **Step 4:** `npx vitest run tests/room-feature-check.test.mjs tests/room-description-dialog.test.mjs` → PASS. **Step 5: Commit** — `git commit -am "#1267: show the description in the puzzle and skill-challenge dialogs"`

### Task 6: First-time presentation wiring (tile + narrative entry)

**Files:**
- Modify: `scripts/room-feature-tokens.mjs` (`runRoomFeatureAction`: new optional dep `presentDescription = async () => {}` called after `revealRoomFeature` for `puzzle`/`skill_challenge`, passing `{ sceneId, roomId, kind, interactorUserId }`; wrapped in try/catch + `console.warn`, never affecting the `{ ok: true }` result), `scripts/module.mjs` (`triggerRoomFeatureToken`'s `runAction`: pass `presentDescription: (a) => presentRoomDescription({ ...a, interactorUserId: game.user.id })`; call `registerRoomDescriptionSocket()` in a `ready` hook beside `registerDungeonActionSocket`), `scripts/dungeon-remote.mjs` (`roomFeatureInteract`: pass `presentDescription: (a) => presentRoomDescription({ ...a, interactorUserId: args.requestingUserId })`), `scripts/ui/dungeon-app.mjs` (~1658: the sidebar fallback path passes `interactorUserId: game.user.id`), `scripts/dungeon-scene.mjs` (`handleDungeonDoorOpened`: after the non-revisit `advanceToRoom` returns `ok` and `room?.kind === "narrative"`, `await presentRoomDescription({ sceneId, roomId, kind: "narrative", interactorUserId: null }).catch(log)` — placed after `focusCameraOnRoom`, before any early return that would skip it; the `revisit` branch is untouched)
- Test: `tests/room-feature-tokens.test.mjs` (extend), `tests/room-description-wiring.test.mjs`

- [ ] **Step 1: Failing tests:** `runRoomFeatureAction` calls `presentDescription` once after a successful reveal for puzzle and skill_challenge, not for treasure, not when the plan fails, and a throwing `presentDescription` still returns `{ ok:true }`; `dungeon-remote` `roomFeatureInteract` forwards `requestingUserId` as `interactorUserId` (read how existing `dungeon-remote` tests call `DUNGEON_ACTIONS`); narrative entry: first entry presents once, `revisit` branch does not, non-narrative kinds untouched (mock `presentRoomDescription` via `vi.mock("../scripts/room-description.mjs")` in a dungeon-scene harness — copy the harness style of the existing `handleDungeonDoorOpened` tests: `grep -ln handleDungeonDoorOpened tests`).
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement.** **Step 4:** the three test files, then `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "#1267: present the room description on first tile use and narrative entry"`

### Task 7: Docs, version and live verification

- [ ] **Step 1:** Run the `update-architecture-docs` skill; commit its output. Bump `module.json`; `npm test` + `npm run validate:dungeon` → PASS; commit `#1267: bump version`.
- [ ] **Step 2: Live verification** (two connected users A and B; copy `.env`; compare the live world's module version to the branch):
  1. A targets a puzzle tile: exactly one chat card appears, B sees a read-only popup with Close, A gets the attempt dialog with the description on top. A second interaction (A or B) shows the description only in that user's own dialog, no new card or popup. Repeat for a skill-challenge room.
  2. A and B target the tile simultaneously: still one card and one popup.
  3. Open the door into a narrative room: everyone sees the popup once and one card; retreat and re-enter: nothing repeats. Entry (safe) room: no popup.
  4. An AI-controlled party / no player at the tile: nothing blocks and the chat card exists. A GM-less run: the interacting player still sees the description in their own dialog.
  5. Tracker: the setpiece block's description matches the popup text for all three kinds; `summary` never appears in popup/card/dialog.
  6. A room whose customization supplied `<b>x</b>` as the description renders it escaped.
- [ ] **Step 3:** Open the PR; after merge label `verification` (needs the live check), remove `claimed`/`in progress`, merge with explicit `--subject/--body`.

## Self-Review

Spec coverage: data + audit guard (T1), state/helper/customization/flag (T2), agent prompt+schema (T3), card/popup/receiver/exactly-once/no-stall (T4), integrated dialogs and no description when nothing attemptable (T5), tile-first-use broadcast + narrative first entry + revisit untouched + wiring through all `runRoomFeatureAction` callers (T6), localization (T4), docs/live verification (T7). Decisions beyond the spec: the executing client shows the popup locally when it is not the interactor (socket emit does not loop back to the sender); `playerDescription` is optional (not required) in the agent schemas so a model that omits it still applies. Types consistent: `roomPlayerDescription`, `markDescriptionShown`, `planDescriptionPresentation`, `presentRoomDescription({ sceneId, roomId, kind, interactorUserId })`, socket `{ type:"roomDescription", sceneId, roomId, kind, exceptUserId }`.
