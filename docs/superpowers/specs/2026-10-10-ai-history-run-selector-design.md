# AI Action Log: Browse Past Runs' History

**Issue:** #1150 — a run selector so archived encounters of completed or earlier runs can be opened in History mode, not only the current run's. Deferred from #1013.

**Builds on:** #1013 / `docs/superpowers/specs/2026-10-09-ai-action-log-history-mode-design.md` (History mode, the encounter select, `listArchivedEncounters`, `loadArchivedRecords`, structured `records` on archive pages), #953 (`scripts/ai-history-journals.mjs`: per-run public and GM journals found by `flags.pf2e-dungeon-crawl.aiHistory = { historyId, kind, sceneId }`, the "AI Action History" folder), #1014 / `docs/superpowers/specs/2026-10-09-ai-history-download-design.md` (Download in History mode), #950 (`AiActionLogApp`, `buildAiLogView`), #1004 (`refreshAiActionLogViews`).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#1013's History mode lists archived encounters for the **current run only** (`state.aiHistoryId`). This spec adds a **Run select above the encounter select** that lists every run whose AI-history journal the user can open (newest first, the current run marked and selected by default), repopulates the encounter select and the combatant and round filters from the chosen run, and keeps visibility identical to the journals' ownership. Runs without usable structured data are listed with a note and a link rather than hidden.

## Investigation findings

Confirmed against the repo.

- **Runs are already discoverable.** `findOrCreateRunJournals` creates, per run, a public journal (`ownership.default` OBSERVER) and a GM journal (`NONE`), both flagged `aiHistory = { historyId, kind: "public" | "gm", sceneId }`, in a folder found by `flags.pf2e-dungeon-crawl.aiHistoryFolder` (or by the name "AI Action History"). Journals are found by flag, never by name; each archived combat is a page flagged `aiHistory.combatId`. Duplicate journals sharing a `historyId` and `kind` resolve to the oldest with a warning (`findRunJournal`).
- **Visibility is ownership.** A player can open only the public journal; a GM can open both. Reading a run through the journal the user can open already enforces the public/GM split, which is how #1013 avoids parsing or leaking GM data.
- **History mode is current-run-scoped by construction.** `listArchivedEncounters({ historyId, isGM })` takes a single `historyId`; the window keeps mode and selected encounter on the app instance and resets them when the run changes.
- **Legacy pages exist.** Pages archived before #1013 lack `aiHistory.records`; #1013 already lists them as "(no structured data — open the journal page)".
- **Download is run-scoped.** #1014's Download exports "the current run's archived history"; once a different run can be viewed, it should follow the viewed run.

## Resolved decisions

1. **Runs listed:** every run whose journal the user can open, newest first; the current run is marked and is the default.
2. **Placement:** a **Run** select above the encounter select in History mode; choosing a run repopulates the encounter select and the combatant and round filters from that run.
3. **Runs without usable data are listed** with a note and a link to the journal page, not hidden.
4. **Extra in scope:** a run summary line (dungeon name, date, encounter count) on each option. **Filed:** remembering the last selected run per user (#1236), an API deep link with `historyId` (#1237), and a GM control to prune old runs (#1238).

## Design

### Listing runs (`scripts/ai-history-store.mjs`)

```js
listArchivedRuns({ isGM, currentHistoryId }) → [
  { historyId, label, dungeonName, createdTime, encounterCount, hasRecords, isCurrent, journalUuid, kind }
]
```

- Reads the journals in the history folder (or all journals carrying the flag), groups them by `historyId`, and picks the journal of the user's kind (`gm` for a GM, falling back to `public` when only that half exists; `public` for non-GMs). A run with neither readable half is skipped.
- `label` is a short summary: the dungeon name (taken from the journal's display name, minus its "AI Action History" prefix), the creation date (`createdTime`, formatted for the user's locale) and the page count: "Crypt of the Fallen · 2026-10-09 · 6 encounters". The current run's label gets "(current)".
- `encounterCount` is the number of pages with `aiHistory.combatId`; `hasRecords` is true when at least one page carries structured `records`.
- Results sort newest first by `createdTime`; the current run is always included even if it has no pages yet (zero encounters), so the selector never lacks its default.
- The function is pure over injected journal collections (the same `deps` pattern as `ai-history-journals.mjs`), so ordering, grouping and labels are unit-testable.

`listArchivedEncounters` and `loadArchivedRecords` are reused unchanged; the window passes the **selected** run's `historyId`.

### Window (`ai-action-log-app.mjs`)

- In History mode the header gains `<select name="run" data-action="selectRun">` above the encounter select. Options come from `listArchivedRuns`; the default is the current run (or the newest run if there is no current run).
- Changing the run sets `app.historyRunId`, resets the encounter selection to that run's newest encounter, and re-renders; the combatant and round selects repopulate from the chosen encounter's records exactly as in #1013. If the selected run has no encounters, the empty state "No archived encounters for this run." shows.
- A run whose journal has no structured data (`hasRecords === false`) is selectable but renders the note "(no structured data — open the journal page)" with a link to the journal page; its encounters cannot be filtered.
- **Mode and selection lifetime.** `historyRunId` lives on the app instance and resets when the current run changes (`historyId` changes) or the window closes, like the encounter selection. Switching back to **Current** is unaffected and always shows the live combat.
- **Download follows the viewed run.** #1014's Download button exports the **selected** run's encounters (the builders and filenames take the run's `historyId` and label); the `api.downloadAiHistory` macro keeps defaulting to the current run.
- Row click-to-pan stays disabled in History, as before.

### Refresh

`refreshAiActionLogViews` still re-renders Current as today. In History, the `createJournalEntryPage` hook filtered by `aiHistory.historyId` re-renders the encounter select only if the page belongs to the **selected** run; a new journal pair for a new run triggers a re-render of the run select (a `createJournalEntry` hook filtered by the `aiHistory` flag) without changing the selection.

### Visibility

Both the run list and the records use the journals the user can open, so a player never sees GM-only runs, rows or fields; `isGM` continues to drive `buildAiLogView`. A player sees a run only if its public journal exists and is observable; a GM-only half (no public journal) is listed for GMs only.

## Error handling

- Missing folder, no journals or a malformed flag: the selector shows only the current run (or "No archived runs.").
- Duplicate journals for one run: the oldest wins with a console warning (existing behavior).
- A run whose pages are malformed: listed with `hasRecords: false` and the note; no throw.
- A journal deleted while selected: the run select falls back to the current run on the next render.
- Reads are GM- or user-client work with no writes; nothing in this feature changes archive content.

## Testing

- **`listArchivedRuns` (pure, injected journals):** grouping by `historyId`, newest-first order, GM vs player journal choice, the current run included when empty, runs missing a readable half skipped, duplicate resolution, labels (dungeon name, date, count), `hasRecords` from pages.
- **Window (mocked DOM):** the run select appears in History only, default and ordering, selecting a run repopulates the encounter/combatant/round selects, reset on run change and window close, empty states, the legacy-run note and link, no click-to-pan.
- **Download:** the selected run's encounters are exported with that run's label.
- **Refresh:** a new page in the selected run updates the encounter select; a page in another run does not disturb the view; a new run updates the run select.
- **Visibility:** a non-GM is never offered a GM-only run and never receives GM-only fields.
- **Regression:** #1013 History mode for the current run is unchanged; Current mode unchanged.
- **Live verification:** finish two runs; open History, switch between the earlier and the current run, filter by combatant and round in each, confirm a player sees only public rows and only runs with a public journal, and download an earlier run.

## Explicitly out of scope

- Remembering the last selected run (#1236), the API deep link with `historyId` (#1237) and pruning/deleting runs from the window (#1238).
- A Download control on the journal sheet header (#1152) and per-encounter download (#1153).
- Merging or comparing runs; editing archive content.

## Open questions

None blocking. Left to planning: whether the dungeon name is read from the journal name or a flag, and the date format helper.
