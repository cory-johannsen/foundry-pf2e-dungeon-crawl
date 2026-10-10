# AI Action Log: History Mode

**Issue:** #1013 — History mode in the #950 action-log window, deferred from #953.

**Builds on:** #953 / `docs/superpowers/specs/2026-10-09-ai-actor-run-history-design.md` (`archiveCombatAiLog`, the public and GM journals, `historyId`), #950 / `docs/superpowers/specs/2026-10-09-ai-actor-action-log-panel-design.md` (`AiActionLogApp`, `buildAiLogView`, `visibleRecords`), #1003 (round groups), #951 (digest).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#953 archives each combat's AI actions into per-run journals as rendered HTML pages. This adds a **History mode** to the #950 window: a header toggle **Current | History**; History shows an encounter select (newest first) for the current run and the same combatant and round filters, with the same row layout. Only the current combat updates live. To make this possible without parsing HTML, the archive step also stores the **structured records** on each journal page.

## Investigation findings

- #953's pages contain escaped HTML built by `buildPublicPageHtml` / `buildGmPageHtml`; there is no machine-readable copy, so the window cannot re-filter or regroup archived encounters from them.
- The two journals are located by `flags.pf2e-dungeon-crawl.aiHistory = { historyId, kind }`, with `historyId` stored in run state (`state.aiHistoryId`). Each page carries `aiHistory.combatId`. Journal ownership already separates public (`OBSERVER`) from GM (`NONE`) content.
- `buildAiLogView(records, { combatantId, round, isGM, ... })` (#950/#1003) is pure and takes any record array, so archived records can feed it directly.
- A log record is small (summary, target, result, plus GM fields on GM pages); a combat's archive is bounded by the combat's length. A typical encounter is tens of records.

## Resolved decisions

1. **Structured records are stored on the page** at archive time (`flags.pf2e-dungeon-crawl.aiHistory.records`), public records on the public page and all records on the GM page. History mode reads the page the user can open, so visibility follows journal ownership.
2. **A header mode toggle (Current | History) with an encounter select.** Filters (combatant, round) and #1003's round groups work identically in History.
3. **Current run only.** Other runs are filed as #1150.
4. **Live updates apply only to Current.** History mode is a snapshot; it re-renders only on user action, or when a new page appears in the run's journal.

## Design

### Archive step amendment (#953)

In `archiveCombatAiLog` step 4, each page is created with
`flags["pf2e-dungeon-crawl"].aiHistory = { combatId, historyId, kind, label, round, recordedAt, records }`:
- Public page: `records = visibleRecords(allRecords, false)` (GM-only rows and fields removed).
- GM page: `records = allRecords`.
- `records` is capped (default 400 per page, newest kept) and its size is checked against a budget before writing; over-budget records are truncated with `truncated: true`. The HTML page content is unchanged.

Existing pages without `records` (archived before this change) appear in History as "(no structured data — open the journal page)" with a link, so nothing breaks.

### Loading history (`scripts/ai-history-store.mjs`, thin Foundry wrapper + pure helpers)

`listArchivedEncounters({ historyId, isGM })` returns `[{ combatId, label, recordedAt, pageUuid, hasRecords }]` newest first, reading pages of the user's visible journal(s) (GM: the GM journal, otherwise the public one). `loadArchivedRecords(pageUuid)` returns `flags…records` (empty array if malformed). The pure helpers (sorting, labeling, truncation notice) are unit-testable; the Foundry reads are injectable.

### Window (`ai-action-log-app.mjs`)

- Header: a segmented control **Current | History** (`data-action="setMode"`). In History, an encounter `<select>` appears (default: the newest), plus the existing combatant and round selects populated from the chosen encounter's records.
- `buildAiLogView(records, { combatantId, round, isGM, expandedRounds, unreadByRound })` runs on the archived records exactly as on live ones; `isGM` still applies, so a GM reading the GM page sees rationale and tags and a player reading the public page cannot.
- Mode and the selected encounter live on the app instance; they reset when the run changes (`historyId` changes) or the window closes. Switching to Current restores live behavior (auto-scroll, unread badges).
- Row click-to-pan is disabled in History (the tokens belong to deleted combats) and the row shows no pointer cursor.
- Empty states: "No archived encounters for this run." and "This encounter has no structured data."

### Entry points

The existing entry points (scene-control tool, chat-card link, macro, sidebar tab if #1004 ships) open Current as before. `api.openAiActionLog({ mode: "history", combatId? })` opens History, optionally on a specific archived encounter. The macro and API parameters are additive.

### Refresh

`refreshAiActionLogViews` (#1004) re-renders Current as today. In History it re-renders only if a new archive page for the run appears (a `createJournalEntryPage` hook filtered by `aiHistory.historyId`), so the encounter select gains the new entry without disturbing the view.

## Error handling

- Missing journals or no `historyId`: History shows the empty state.
- Malformed or oversized `records`: treated as empty / truncated with a notice.
- A player without access to the GM journal never sees it listed; the public page is used.
- Archive failures remain swallowed per #953; a missing page just means no entry.

## Testing

- **Archive amendment:** public vs GM `records`, cap and truncation, idempotence, unchanged HTML.
- **Store:** listing order, visibility by role, malformed flags, legacy pages without `records`.
- **Window (mocked DOM):** mode toggle, encounter select, filters on archived records, no click-to-pan in History, state reset on run change, Current unaffected.
- **Visibility:** a non-GM never receives GM-only fields in History.
- **Live verification:** finish two combats in a run; open History; filter by combatant and round; confirm a player sees only public rows; start a third combat and see Current update live while History stays put.

## Explicitly out of scope

- Browsing earlier or completed runs' histories — #1150.
- Editing or deleting archived pages from the window.
- HTML parsing of legacy pages (rejected).

## Open questions

None. Planning-time details: the per-page flag size budget and whether `records` is trimmed further for very long combats.
