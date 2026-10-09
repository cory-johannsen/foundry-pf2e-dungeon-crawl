# Advanced AI Actors: AI Action History Across the Dungeon Run

**Issue:** #953 — keep AI action history across the whole dungeon run (browsable per room/encounter), optionally export (a deferred follow-up of #925).

**Builds on:** #925 / `docs/superpowers/specs/2026-10-08-ai-actor-action-display-design.md` (the per-combat structured `agentLog`, discarded with the combat), #950 (visibility rules and pure view builders), #952 / `docs/superpowers/specs/2026-10-09-ai-actor-decision-details-design.md` (alternatives and decision metadata on the record), and the run lifecycle in `scripts/dungeon-runner.mjs` and `scripts/dungeon-scene.mjs` (`resolveCombat`, `abandonRun`, reset, `teardownDungeonRun`, `sweepCompletedDungeonScene`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#925 keeps AI action history for the **current combat only**: the structured log lives on the combat document and disappears when the combat resolves. This spec preserves it for the **whole dungeon run**. When a combat resolves, its AI action log is **archived into a Foundry journal** created for the run: one page per encounter, with a **public page** (what each AI did and the result) and a **GM-only page** (rationale, alternatives considered, decision metadata). Journals are the right container: they survive the run scene being deleted, are browsable with Foundry's own journal sheet, are natively exportable, and — unlike combat flags — have **real server-side permissions**, so the GM-only content is genuinely hidden from players, not merely hidden in the UI.

A completed run keeps its journals; an abandoned or reset run deletes them.

## Investigation findings

Confirmed against the repo.

- **Run state lives in a world setting.** Dungeon runs are stored in `dungeonRuns[sceneId]` (`dungeon-runner.mjs`); every write replaces the whole setting and broadcasts it to all clients (`persist`). `abandonRun` deletes the run's entry; reset removes it too; a completed run keeps its entry with `completed: true`. Putting per-action history in that setting would bloat a setting that is rewritten and re-broadcast on every change, so it is the wrong carrier.
- **The run scene is temporary.** `teardownDungeonRun` deletes the dungeon scene when a run is abandoned, so scene flags would be lost; combat documents are deleted by `resolveCombat` when combat ends. Neither can hold run-wide history.
- **Run state has per-room structure to name encounters.** `state.rooms` (graph of rooms with kinds and ids), `state.history` (resolved rooms) and the combat's `dungeonSlot` flag identify which room a combat belonged to; standalone combats carry an `encounterId` flag instead and have no room.
- **`resolveCombat` is the natural archive point.** It already grants rewards and deletes the combat; concurrent resolution is guarded by `resolvingCombatIds`. It runs on the GM client (`game.user.isGM` is required), including in GM-less runs where the relay's GM account is that client, so a GM-only document write there is permitted.
- **Permissions.** Foundry journal documents have an `ownership` map; a top-level document the user has no permission for is not delivered to that client, while embedded page-level hiding has narrower guarantees. A GM-only **top-level** journal is the dependable way to keep content from players.
- **The record is rich enough.** After #925/#950/#952 each log record carries `combatantId`, `tokenId`, `round`, `turn`, `index`, `summary`, `target`, `result`, `rationale`, `source`, `visibility`, `alternatives`, `moreCount`, `meta` and `fallbackReason`.

## Resolved decisions

1. **Storage: a Journal Entry per run, one page per encounter.**
2. **Browsing: Foundry's own journal sheet.** A "History" mode in the #950 window is #1013.
3. **Content: a public page (what + result) and a GM-only page (rationale, alternatives, metadata) per encounter**, kept in separate documents so the GM-only content has real permissions.
4. **Lifecycle:** archive when a combat resolves; keep after the run completes; delete when the run is abandoned or reset. A Markdown/JSON download is #1014.

## Design

### Two journals per run

For each run the module maintains two journal entries, found by a flag rather than by name:

- **`AI Action History — <dungeon name>`** (public): `ownership.default = OBSERVER`, so every player can open it from the Journal sidebar. Holds one page per archived encounter with the public rows.
- **`AI Action Details — <dungeon name> (GM)`**: `ownership.default = NONE`, so only GMs receive it. Holds a matching page per encounter with the GM-only rows.

Both carry `flags.pf2e-dungeon-crawl.aiHistory = { historyId, kind: "public" | "gm" }`. `historyId` is a short id generated the first time the run archives a combat and stored in the run state (`state.aiHistoryId`, a small string in the `dungeonRuns` setting); the journals are located by `historyId`, so renaming them does not break the link. Both are filed in a folder "AI Action History" (created if missing). Planning confirms whether page-level ownership inside one journal is filtered server-side by the installed Foundry version; if it is, the two journals may collapse into one with a restricted page per encounter, but the two-entry design is the specified default because it relies only on top-level document permissions.

### Archive step

`archiveCombatAiLog(combat)` is called from `resolveCombat` **before** the combat document is deleted, on the GM client, guarded by the existing `resolvingCombatIds` concurrency check and an idempotence check (a page whose `flags.pf2e-dungeon-crawl.aiHistory.combatId` equals the combat id means "already archived"):

1. Read `flags.pf2e-dungeon-crawl.agentLog`; if empty or malformed, return without creating anything (a combat with no AI actions leaves no page).
2. Resolve the encounter label from the combat: for a dungeon combat, the room's number and kind from run state via `dungeonSlot` (for example "Room 4 — Combat"); for a standalone combat, "Encounter" plus the scene name; both with the game-clock time (#785) when available.
3. Ensure the run's two journals exist (create them and the folder lazily).
4. Create one page in each journal, titled with the encounter label, `flags…aiHistory.combatId` set, content built by the pure builders below.

The step never blocks combat resolution: any failure is logged (`console.error`) and swallowed.

### Page content (pure builders, `scripts/ai-history-pages.mjs`)

- `buildPublicPageHtml(records)` — per round a heading, then a table of rows: combatant, summary, target, result chip. Uses the same public-row reduction as #950 (`visibleRecords(records, false)`): rows with `visibility: "gm"` (hidden-token actors) are **omitted from the public page** entirely.
- `buildGmPageHtml(records)` — the same rows for **all** records (including GM-only), each followed by the rationale, the fallback tag and reason, the alternatives list (chosen highlighted, with "+N more"), and the decision metadata lines from #952's `buildDecisionDetails`.
- All strings (summaries, names, rationale) are escaped; no unvetted HTML is ever emitted.

### Browsing

Players and the GM open "AI Action History — …" from the Journal sidebar and read per-encounter pages; the GM additionally has the "(GM)" journal. No new UI is added in this issue.

### Lifecycle

- **Created:** lazily, at the first combat archive of a run.
- **Appended:** one page per archived combat; pages are never edited afterward.
- **Completed run:** the journals stay (the run entry stays with `completed: true`).
- **Abandon or reset:** `abandonRun` and the reset path (the same code paths that delete the run entry) also delete both journals and the folder if it is left empty. These paths already run through the GM client (`relay` for a non-GM host), so the deletion executes with GM permission.
- **A new run** gets its own `historyId` and its own pair of journals.
- A user may delete the journals manually at any time; the next archive recreates them.

### GM-less mode

Archiving happens in `resolveCombat` on the GM client (the relay's GM account in a run with no human GM), so journal creation works without a human GM. Players see the public journal in their sidebar through Foundry's normal document delivery.

## Error handling

- Any failure to create a folder, journal or page is logged and skipped; combat resolution and reward granting proceed unchanged.
- A malformed or missing `agentLog` creates nothing.
- If the run state has no `aiHistoryId`, one is generated and persisted before the first page is created; a failure to persist it skips archiving for that combat rather than orphaning pages.
- Journal lookup by `historyId` that finds duplicates uses the oldest and logs a warning.
- Deleting the journals on abandon/reset is best-effort: a failure leaves them behind (visible to the GM to delete manually) and does not block the abandon/reset.

## Testing

- **Pure builders:** public page omits GM-only rows and all rationale/details; GM page includes everything including alternatives and metadata; escaping of hostile strings; round headings and ordering; empty input.
- **Archive flow (mocked Foundry):** no pages for an empty/malformed log; journals and folder created lazily with the right ownership (`OBSERVER` public, `NONE` GM) and flags; a page per archived combat in both journals; idempotence (a second call for the same combat creates nothing); encounter labels for dungeon and standalone combats; a failing journal write does not stop combat resolution.
- **Lifecycle:** completed run keeps journals; abandon and reset delete both and an empty folder; a new run uses a new `historyId`; manual deletion then re-archive recreates them.
- **Permissions:** the public journal's default ownership is observer, the GM journal's is none; a simulated non-GM user cannot read the GM journal.
- **GM-less path:** archive runs on a GM client without a human GM; the relay deletion on abandon removes the journals.
- **Regression:** existing `resolveCombat`, `abandonRun` and reset tests keep passing.
- **Live verification:** run a dungeon with several AI fights; as a player confirm the public journal lists one page per encounter with what/result only and the GM journal is absent; as the GM confirm rationale and alternatives are present; abandon a run and confirm both journals disappear while a completed run keeps them.

## Explicitly out of scope

- A "History" mode in the #950 action-log window — #1013.
- Markdown/JSON download of a run's history — #1014.
- Editing or annotating archived pages (they are written once).
- History across multiple runs in one view.
- Changing what the live per-combat log or chat cards (#925) show.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: whether the installed Foundry filters page-level ownership server-side (to collapse to one journal), the exact run-state fields available for encounter labels, where `aiHistoryId` is persisted, and the folder/journal naming strings.
